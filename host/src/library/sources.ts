import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { harborMountFor } from '../drives.js';
import { isUnderRoots } from './catalogue.js';

/** Playing a track whose folder, drive or share is not connected. */
export class SourceUnavailableError extends Error {
  constructor(track: { title: string }) {
    super(`Not connected — cannot play "${track.title}" now`);
  }
}

/** checking: not known yet; connected: readable and not empty; disconnected: anything else. */
export type SourceState = 'checking' | 'connected' | 'disconnected';

/** Longer than the automount's own mount timeout (30 s drives, 15 s shares) is pointless. */
const PROBE_TIMEOUT_MS = 20_000;
/** How often every root is looked at again — a drive plugged back in shows up by then. */
const RECHECK_MS = 30_000;
const SMB_PORT = 445;
const SMB_CONNECT_TIMEOUT_MS = 3000;

/**
 * Whether each library root can be read now — found out without Harbor's own threads.
 *
 * A stat of an unplugged drive's automount or of an unreachable SMB share hangs until the
 * mount times out. On the event loop that stalls every request; with fs.promises it ties up
 * one of libuv's four pool threads, and a few of those starve static files, artwork and
 * everything else that reads a file. So: a drive is looked up by its UUID in /dev, a share's
 * server is asked on port 445, and only then a `find` in a child process reads the folder.
 *
 * Emits `change` when a root's state changes.
 */
export class SourceMonitor extends EventEmitter {
  private readonly states = new Map<string, SourceState>();
  private readonly running = new Map<string, Promise<boolean>>();
  /** Roots whose last probe is still stuck in the kernel — no second one meanwhile. */
  private readonly stuck = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly roots: () => string[]) {
    super();
  }

  start(): void {
    void this.checkAll();
    this.timer = setInterval(() => void this.checkAll(), RECHECK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Looks at every root again (after adding, removing or ejecting one too). */
  async checkAll(): Promise<void> {
    const roots = this.roots().map((r) => path.resolve(r));
    let dropped = false;
    for (const key of this.states.keys()) {
      if (!roots.includes(key)) dropped = this.states.delete(key) || dropped;
    }
    if (dropped) this.emit('change');
    await Promise.all(roots.map((root) => this.check(root)));
  }

  /** State of a library root. */
  state(root: string): SourceState {
    return this.states.get(path.resolve(root)) ?? 'checking';
  }

  /** The root `filePath` lies in (the deepest one), or null. */
  private rootOf(filePath: string): string | null {
    let best: string | null = null;
    for (const root of this.roots()) {
      const resolved = path.resolve(root);
      if (isUnderRoots(filePath, [resolved]) && (!best || resolved.length > best.length)) best = resolved;
    }
    return best;
  }

  /** The last look found the source of `filePath` readable — reading it will not hang. */
  isConnected(filePath: string): boolean {
    const root = this.rootOf(filePath);
    return !root || this.state(root) === 'connected';
  }

  /** The last look found the source of `filePath` unplugged, unmounted, unreachable or empty. */
  isDisconnected(filePath: string): boolean {
    const root = this.rootOf(filePath);
    return Boolean(root) && this.state(root!) === 'disconnected';
  }

  /**
   * Whether the source of `filePath` can be read. Unknown: looks now. Disconnected: answers at
   * once and looks again in the background, so a drive plugged back in is found by the next tap.
   */
  async ensure(filePath: string): Promise<boolean> {
    const root = this.rootOf(filePath);
    if (!root) return true;
    const state = this.state(root);
    if (state === 'connected') return true;
    if (state === 'disconnected') {
      void this.check(root);
      return false;
    }
    return this.check(root);
  }

  private check(root: string): Promise<boolean> {
    const running = this.running.get(root);
    if (running) return running;
    const run = probe(root, this.stuck)
      .catch(() => false)
      .then((ok) => {
        this.running.delete(root);
        // Removed while it was looked at.
        if (this.roots().some((r) => path.resolve(r) === root)) this.set(root, ok ? 'connected' : 'disconnected');
        return ok;
      });
    this.running.set(root, run);
    return run;
  }

  private set(root: string, state: SourceState): void {
    if (this.states.get(root) === state) return;
    const before = this.states.get(root);
    this.states.set(root, state);
    if (before || state === 'disconnected') {
      console.log(`Library: ${root} is ${state === 'connected' ? 'connected' : 'not connected'}`);
    }
    this.emit('change');
  }
}

async function probe(root: string, stuck: Set<string>): Promise<boolean> {
  const mount = harborMountFor(root);
  if (mount?.uuid && !fs.existsSync(`/dev/disk/by-uuid/${mount.uuid}`)) return false;
  if (mount?.server && !(await reachable(mount.server, SMB_PORT))) return false;
  if (stuck.has(root)) return false;
  return process.platform === 'win32' ? readableInProcess(root) : readableInChild(root, stuck);
}

/** A TCP connect to `host:port` within SMB_CONNECT_TIMEOUT_MS. */
function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(SMB_CONNECT_TIMEOUT_MS, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** The folder holds at least one entry — read by `find` in its own process. */
function readableInChild(root: string, stuck: Set<string>): Promise<boolean> {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const child = spawn('find', [root, '-mindepth', '1', '-maxdepth', '1', '-print', '-quit'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const timer = setTimeout(() => {
      // A process in uninterruptible sleep may outlive the kill — remember it until it exits.
      stuck.add(root);
      child.kill('SIGKILL');
      finish(false);
    }, PROBE_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => (out += chunk));
    child.on('error', () => finish(false));
    child.on('close', (code) => {
      stuck.delete(root);
      finish(code === 0 && out.trim().length > 0);
    });
  });
}

/** Windows has no POSIX find: read the folder here, with the timeout. */
async function readableInProcess(root: string): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
  });
  try {
    const read = fs.promises.readdir(root).then((names) => names.length > 0, () => false);
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
