import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { promisify } from 'node:util';
import { appRootPath } from './paths.js';

const run = promisify(execFile);

/** Where the releases come from. */
const REPO = 'petergerov/audio-harbor-headless';
/** Root helper from the Linux package; the service may run it through sudo (group harbor-drives). */
const HELPER = '/usr/libexec/audio-harbor-headless/harbor-update';
/** The unit the helper runs the update in — outside the service, which apt restarts. */
const UNIT = 'audio-harbor-update';
/** How the helper's update goes: state=, version=, message= lines. */
const STATUS_FILE = '/run/audio-harbor-headless/update';
/** Where the .deb and the .pkg install the app. */
const DEB_ROOT = '/opt/audio-harbor-headless';
const PKG_ROOT = '/usr/local/audio-harbor-headless';
/** A check this recent answers without asking GitHub again; a failed one is tried again sooner. */
const CHECK_TTL_MS = 60 * 60 * 1000;
const RETRY_MS = 60 * 1000;

export type UpdateState = 'idle' | 'starting' | 'downloading' | 'installing' | 'done' | 'failed';
const RUNNING: UpdateState[] = ['starting', 'downloading', 'installing'];

export interface UpdateStatus {
  /** The version that runs: "1.0.2". */
  current: string;
  /** The latest release on GitHub, without the v; null until a check went through. */
  latest: string | null;
  tag: string | null;
  releaseUrl: string | null;
  available: boolean;
  /** This host installs it itself: the .deb, run as the audioharbor@ service. */
  canInstall: boolean;
  /** Why it is not installed from here, or how to update instead. */
  note: string | null;
  checkedAt: number | null;
  /** Why the last check failed. */
  checkError: string | null;
  /** The update the helper runs, or ran last since boot. */
  state: UpdateState;
  target: string | null;
  message: string | null;
}

export class UpdateError extends Error {}

interface Release {
  tag: string;
  url: string;
  assets: string[];
}

/** 1.0.10 is newer than 1.0.9; a suffix (-beta) is left out. */
export function isNewer(a: string, b: string): boolean {
  const parts = (v: string) =>
    (v.replace(/^v/, '').split(/[^0-9.]/)[0] ?? '').split('.').map((n) => Number(n) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

/** The Debian name of this CPU, as in the .deb file names. */
function debArch(): string {
  return os.arch() === 'x64' ? 'amd64' : os.arch();
}

function installKind(): 'deb' | 'pkg' | 'other' {
  const root = appRootPath();
  if (process.platform === 'linux' && root === DEB_ROOT && fs.existsSync(HELPER)) return 'deb';
  if (process.platform === 'darwin' && root === PKG_ROOT) return 'pkg';
  return 'other';
}

let allowed = false;

async function helperAllowed(): Promise<boolean> {
  if (allowed) return true;
  try {
    await run('sudo', ['-n', '-l', HELPER], { timeout: 5000 });
    allowed = true;
  } catch {
    allowed = false;
  }
  return allowed;
}

async function unitActive(): Promise<boolean> {
  try {
    await run('systemctl', ['is-active', '--quiet', UNIT], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** What the helper wrote last; an update that stopped without saying so counts as failed. */
async function helperStatus(): Promise<Pick<UpdateStatus, 'state' | 'target' | 'message'>> {
  let text = '';
  try {
    text = fs.readFileSync(STATUS_FILE, 'utf8');
  } catch {
    return { state: 'idle', target: null, message: null };
  }
  const fields = new Map<string, string>();
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) fields.set(line.slice(0, i), line.slice(i + 1));
  }
  const known: UpdateState[] = [...RUNNING, 'done', 'failed'];
  const state = known.find((s) => s === fields.get('state')) ?? 'idle';
  const target = fields.get('version') || null;
  const message = fields.get('message') || null;
  if (RUNNING.includes(state) && !(await unitActive())) {
    return { state: 'failed', target, message: `The update stopped — journalctl -u ${UNIT}` };
  }
  return { state, target, message };
}

async function latestRelease(version: string): Promise<Release> {
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `audio-harbor-headless/${version}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error('GitHub did not answer — is the host online?');
  }
  if (res.status === 403 || res.status === 429) throw new Error('GitHub limits checks for now — try again later');
  if (res.status === 404) throw new Error('No release on GitHub yet');
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const body = (await res.json()) as { tag_name?: string; html_url?: string; assets?: { name?: string }[] };
  if (!body.tag_name) throw new Error('GitHub sent no version');
  return {
    tag: body.tag_name,
    url: body.html_url ?? `https://github.com/${REPO}/releases`,
    assets: (body.assets ?? []).map((a) => a.name ?? ''),
  };
}

/** The latest release on GitHub, and on a .deb install the update to it through the root helper. */
export class Updater {
  private release: Release | null = null;
  private checkedAt: number | null = null;
  private checkError: string | null = null;
  private checking: Promise<void> | null = null;

  constructor(private readonly version: string) {}

  /** `check`: ask GitHub now, not only when the last answer is an hour old. */
  async status(check = false): Promise<UpdateStatus> {
    const ttl = this.checkError ? RETRY_MS : CHECK_TTL_MS;
    if (check || this.checkedAt === null || Date.now() - this.checkedAt > ttl) await this.check();
    const release = this.release;
    const latest = release ? release.tag.replace(/^v/, '') : null;
    const available = latest !== null && isNewer(latest, this.version);
    const kind = installKind();
    let canInstall = false;
    let note: string | null = null;
    if (available && release) {
      if (kind === 'deb') {
        if (!release.assets.some((a) => a.endsWith(`_${debArch()}.deb`))) {
          note = `${release.tag} has no package for ${debArch()} yet.`;
        } else if (!(await helperAllowed())) {
          note = 'Installing updates works when Harbor runs as the audioharbor@ service.';
        } else {
          canInstall = true;
        }
      } else if (kind === 'pkg') {
        note = 'Install the new .pkg from the release page on the Mac.';
      } else {
        note = 'Download the new package from the release page.';
      }
    }
    return {
      current: this.version,
      latest,
      tag: release?.tag ?? null,
      releaseUrl: release?.url ?? null,
      available,
      canInstall,
      note,
      checkedAt: this.checkedAt,
      checkError: this.checkError,
      ...(kind === 'deb' ? await helperStatus() : { state: 'idle' as const, target: null, message: null }),
    };
  }

  /** Starts the update to `tag` — the latest release — and answers at once; apt restarts Harbor. */
  async install(tag: string): Promise<UpdateStatus> {
    if (!/^v\d/.test(tag)) throw new UpdateError('No version to install');
    const before = await this.status();
    if (RUNNING.includes(before.state)) throw new UpdateError('An update is already running');
    if (!before.available || before.tag !== tag) throw new UpdateError(`${tag} is not a newer release`);
    if (!before.canInstall) throw new UpdateError(before.note ?? 'Updates are not installed from here');
    try {
      await run('sudo', ['-n', HELPER, 'install', tag], { timeout: 30_000 });
    } catch (err) {
      const stderr = String((err as { stderr?: string }).stderr ?? '').trim();
      throw new UpdateError(stderr.split('\n').pop() || 'The update helper failed');
    }
    return this.status();
  }

  private async check(): Promise<void> {
    this.checking ??= (async () => {
      try {
        this.release = await latestRelease(this.version);
        this.checkError = null;
      } catch (err) {
        this.checkError = err instanceof Error ? err.message : String(err);
      }
      this.checkedAt = Date.now();
    })().finally(() => {
      this.checking = null;
    });
    await this.checking;
  }
}
