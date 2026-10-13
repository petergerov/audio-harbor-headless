import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface DiskUsage {
  /** Mount point (Linux) or the folder itself. */
  mount: string;
  /** What lives there: Harbor data, or the library folders on it. */
  uses: string[];
  totalBytes: number;
  freeBytes: number;
}

export interface SystemStatus {
  hostname: string;
  platform: string;
  cpu: {
    model: string;
    cores: number;
    /** Busy share of all cores since the previous call, 0–100. */
    usagePercent: number;
    load1: number;
    /** SoC temperature where the system reports one (Raspberry Pi). */
    temperatureC: number | null;
  };
  memory: { totalBytes: number; availableBytes: number; harborBytes: number };
  disks: DiskUsage[];
  uptimeSecs: number;
  harborUptimeSecs: number;
}

/** A drive that does not answer in this time is left out — an unplugged automount takes seconds. */
const STATFS_TIMEOUT_MS = 1500;

let lastCpu = cpuTimes();

function cpuTimes(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.irq + t.idle;
  }
  return { idle, total };
}

function cpuUsage(): number {
  const now = cpuTimes();
  const total = now.total - lastCpu.total;
  const idle = now.idle - lastCpu.idle;
  lastCpu = now;
  return total > 0 ? Math.round(((total - idle) / total) * 1000) / 10 : 0;
}

/** The CPU model, or on ARM boards (Node says "unknown") the board: "Raspberry Pi 4 Model B Rev 1.4". */
function cpuModel(cpus: os.CpuInfo[]): string {
  const model = cpus[0]?.model.trim();
  if (model && model !== 'unknown') return model;
  try {
    return fs.readFileSync('/proc/device-tree/model', 'utf8').replace(/\0/g, '').trim() || os.arch();
  } catch {
    return os.arch();
  }
}

function temperature(): number | null {
  try {
    const milli = Number(fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8').trim());
    return Number.isFinite(milli) ? Math.round(milli / 100) / 10 : null;
  } catch {
    return null;
  }
}

/** Mount points from /proc/self/mounts, longest first (Linux); empty elsewhere. */
function mountPoints(): string[] {
  try {
    return fs
      .readFileSync('/proc/self/mounts', 'utf8')
      .split('\n')
      .map((line) => line.split(' '))
      .filter((f) => f.length > 2 && f[2] !== 'autofs')
      .map((f) => f[1]!.replace(/\\040/g, ' '))
      .sort((a, b) => b.length - a.length);
  } catch {
    return [];
  }
}

/**
 * Memory the system can hand out. Linux: MemAvailable (os.freemem). macOS counts only
 * untouched pages as free — add the inactive and speculative ones (cache the system frees on demand).
 */
async function availableMemory(): Promise<number> {
  if (process.platform !== 'darwin') return os.freemem();
  try {
    const { stdout } = await run('vm_stat', [], { timeout: 2000 });
    const pageSize = Number(stdout.match(/page size of (\d+) bytes/)?.[1] ?? 4096);
    const pages = (name: string) => Number(stdout.match(new RegExp(`Pages ${name}:\\s+(\\d+)`))?.[1] ?? 0);
    return (pages('free') + pages('inactive') + pages('speculative')) * pageSize;
  } catch {
    return os.freemem();
  }
}

/** Without /proc/self/mounts (macOS): the volume a folder is on, by its path. */
function volumeOf(p: string): string {
  const parts = path.resolve(p).split('/');
  return parts[1] === 'Volumes' && parts[2] ? `/Volumes/${parts[2]}` : '/';
}

function mountOf(p: string, mounts: string[]): string {
  const resolved = path.resolve(p);
  return mounts.find((m) => m === '/' || resolved === m || resolved.startsWith(`${m}/`)) ?? resolved;
}

/** Resolves to null when `op` takes too long or fails. */
async function withTimeout<T>(op: Promise<T>): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), STATFS_TIMEOUT_MS);
  });
  try {
    return await Promise.race([op.catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** CPU, memory and the disks Harbor uses: its data folder and every library folder. */
export async function systemStatus(dataDir: string, libraryRoots: string[]): Promise<SystemStatus> {
  const mounts = mountPoints();
  const folders = [
    { path: dataDir, use: 'Harbor data' },
    ...libraryRoots.map((root) => ({ path: root, use: path.basename(root) || root })),
  ];
  // One entry per volume (device id); unplugged or unreadable folders are left out.
  const byDevice = new Map<number, { path: string; uses: string[] }>();
  for (const folder of folders) {
    const st = await withTimeout(fs.promises.stat(folder.path));
    if (!st) continue;
    const entry = byDevice.get(st.dev) ?? { path: folder.path, uses: [] };
    if (!entry.uses.includes(folder.use)) entry.uses.push(folder.use);
    byDevice.set(st.dev, entry);
  }
  const disks: DiskUsage[] = [];
  for (const { path: p, uses } of byDevice.values()) {
    const st = await withTimeout(fs.promises.statfs(p));
    if (!st) continue;
    disks.push({
      mount: mounts.length ? mountOf(p, mounts) : volumeOf(p),
      uses,
      totalBytes: st.blocks * st.bsize,
      freeBytes: st.bavail * st.bsize,
    });
  }

  const cpus = os.cpus();
  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()} · ${os.arch()}`,
    cpu: {
      model: cpuModel(cpus),
      cores: cpus.length,
      usagePercent: cpuUsage(),
      load1: Math.round(os.loadavg()[0]! * 100) / 100,
      temperatureC: temperature(),
    },
    memory: {
      totalBytes: os.totalmem(),
      availableBytes: await availableMemory(),
      harborBytes: process.memoryUsage().rss,
    },
    disks,
    uptimeSecs: Math.round(os.uptime()),
    harborUptimeSecs: Math.round(process.uptime()),
  };
}
