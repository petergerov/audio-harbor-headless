import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Root helper from the Linux package; the service may run it through sudo (group harbor-drives). */
const HELPER = '/usr/libexec/audio-harbor-headless/harbor-drive';
/** Where the helper mounts drives — fstab entries below it belong to Harbor. */
export const DRIVE_BASE = '/mnt/harbor';
const SUPPORTED_FS = new Set(['exfat', 'vfat', 'ntfs', 'ext2', 'ext3', 'ext4', 'btrfs', 'xfs']);
/** A disk with one of these mounted is the one the system runs from. */
const SYSTEM_MOUNTS = new Set(['/', '/boot', '/boot/firmware', '/usr', '/var', '/home', '[SWAP]']);

export interface Drive {
  /** A local disk, or an SMB share on the network. */
  kind: 'drive' | 'share';
  /** Disk: the file system UUID. Share: empty. */
  uuid: string;
  /** Volume label, else the disk model, else the device. */
  title: string;
  device: string | null;
  fsType: string;
  sizeBytes: number | null;
  connected: boolean;
  /** Set when the drive has a Harbor fstab entry. */
  name: string | null;
  mountPoint: string | null;
  mounted: boolean;
  /** Name offered when setting it up. */
  suggestedName: string;
}

export interface DriveList {
  /** False off Linux, without the package, or when not started by the service. */
  supported: boolean;
  /** Why not, when it is worth telling. */
  reason: string | null;
  drives: Drive[];
}

interface BlockDevice {
  name: string;
  path: string;
  pkname: string | null;
  type: string;
  fstype: string | null;
  label: string | null;
  uuid: string | null;
  size: number | null;
  mountpoints: (string | null)[];
  model: string | null;
}

interface FstabEntry {
  uuid: string;
  /** `//server/share` for an SMB share. */
  share: string | null;
  mountPoint: string;
  fsType: string;
}

export class DriveError extends Error {}

let allowed: boolean | null = null;

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

async function blockDevices(): Promise<BlockDevice[]> {
  const { stdout } = await run(
    'lsblk',
    ['-J', '-b', '--list', '-o', 'NAME,PATH,PKNAME,TYPE,FSTYPE,LABEL,UUID,SIZE,MOUNTPOINTS,MODEL'],
    { timeout: 10_000 }
  );
  const parsed = JSON.parse(stdout) as { blockdevices?: BlockDevice[] };
  return parsed.blockdevices ?? [];
}

function harborEntries(): FstabEntry[] {
  let text = '';
  try {
    text = fs.readFileSync('/etc/fstab', 'utf8');
  } catch {
    return [];
  }
  const entries: FstabEntry[] = [];
  for (const line of text.split('\n')) {
    const [spec, mountPoint, fsType] = line.trim().split(/\s+/);
    if (!spec || spec.startsWith('#') || !mountPoint?.startsWith(`${DRIVE_BASE}/`)) continue;
    const uuid = spec.match(/^UUID="?([^"]+)"?$/)?.[1];
    if (uuid) entries.push({ uuid, share: null, mountPoint, fsType: fsType ?? '' });
    else if (spec.startsWith('//') && fsType === 'cifs') {
      entries.push({ uuid: '', share: spec.replace(/\\040/g, ' '), mountPoint, fsType });
    }
  }
  return entries;
}

function isMounted(mountPoint: string): boolean {
  try {
    // Until first access only the automount stub (autofs) sits there.
    const mounts = fs.readFileSync('/proc/self/mounts', 'utf8');
    return mounts
      .split('\n')
      .some((line) => {
        const [, target, type] = line.split(' ');
        return target === mountPoint && type !== 'autofs';
      });
  } catch {
    return false;
  }
}

export function suggestName(text: string): string {
  const name = text
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+|-+$/g, '')
    .slice(0, 32);
  return name || 'music';
}

export async function listDrives(): Promise<DriveList> {
  if (process.platform !== 'linux') return { supported: false, reason: null, drives: [] };
  if (!fs.existsSync(HELPER)) {
    return { supported: false, reason: 'Setting up drives needs the Debian package.', drives: [] };
  }
  if (!(await helperAllowed())) {
    return {
      supported: false,
      reason: 'Setting up drives works when Harbor runs as the audioharbor@ service.',
      drives: [],
    };
  }

  const devices = await blockDevices();
  const byName = new Map(devices.map((d) => [d.name, d]));
  const diskOf = (d: BlockDevice): string => {
    let current = d;
    while (current.pkname && byName.has(current.pkname)) current = byName.get(current.pkname)!;
    return current.name;
  };
  const systemDisks = new Set(
    devices.filter((d) => d.mountpoints.some((m) => m && SYSTEM_MOUNTS.has(m))).map(diskOf)
  );
  const entries = harborEntries();
  const entryByUuid = new Map(entries.filter((e) => !e.share).map((e) => [e.uuid, e]));

  const drives: Drive[] = [];
  for (const d of devices) {
    if (!d.uuid || !d.fstype || !SUPPORTED_FS.has(d.fstype)) continue;
    if (d.type !== 'part' && d.type !== 'disk') continue;
    const entry = entryByUuid.get(d.uuid);
    if (!entry && systemDisks.has(diskOf(d))) continue;
    // In use elsewhere — only a desktop mount under /media is taken over on setup.
    if (!entry && d.mountpoints.some((m) => m && !m.startsWith('/media/'))) continue;
    const disk = byName.get(diskOf(d));
    const title = d.label || disk?.model?.trim() || d.path;
    drives.push({
      kind: 'drive',
      uuid: d.uuid,
      title,
      device: d.path,
      fsType: d.fstype,
      sizeBytes: d.size,
      connected: true,
      name: entry ? path.basename(entry.mountPoint) : null,
      mountPoint: entry?.mountPoint ?? null,
      mounted: entry ? isMounted(entry.mountPoint) : false,
      suggestedName: suggestName(title),
    });
    entryByUuid.delete(d.uuid);
  }
  // Set up, but unplugged.
  for (const entry of entryByUuid.values()) {
    const name = path.basename(entry.mountPoint);
    drives.push({
      kind: 'drive',
      uuid: entry.uuid,
      title: name,
      device: null,
      fsType: entry.fsType,
      sizeBytes: null,
      connected: false,
      name,
      mountPoint: entry.mountPoint,
      mounted: false,
      suggestedName: name,
    });
  }
  // SMB shares: reachable or not shows on access; "mounted" says whether it is mounted now.
  for (const entry of entries.filter((e) => e.share)) {
    const name = path.basename(entry.mountPoint);
    drives.push({
      kind: 'share',
      uuid: '',
      title: entry.share!,
      device: entry.share,
      fsType: 'smb',
      sizeBytes: null,
      connected: true,
      name,
      mountPoint: entry.mountPoint,
      mounted: isMounted(entry.mountPoint),
      suggestedName: name,
    });
  }
  return { supported: true, reason: null, drives };
}

/** Runs the root helper; `input` goes to its stdin (SMB password — never on the command line). */
async function helper(args: string[], input = ''): Promise<string> {
  if (!(await helperAllowed())) throw new DriveError('Setting up drives is not available on this host');
  return new Promise((resolve, reject) => {
    const child = spawn('sudo', ['-n', HELPER, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), 90_000);
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new DriveError(err.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new DriveError(stderr.trim().split('\n').pop() || 'The drive helper failed'));
    });
    child.stdin.end(input);
  });
}

export interface ShareSettings {
  /** nas.local or an IP address. */
  server: string;
  share: string;
  domain?: string;
  /** Empty: guest access. */
  user?: string;
  password?: string;
}

/** SMB share → fstab entry + mount; answers with the mount point. */
export async function setUpShare(settings: ShareSettings, name: string): Promise<string> {
  const lines = [settings.server, settings.share, settings.domain ?? '', settings.user ?? '', settings.password ?? ''];
  if (lines.some((l) => /[\r\n]/.test(l))) throw new DriveError('Line breaks are not allowed');
  return helper(['add-smb', name], `${lines.join('\n')}\n`);
}

/** fstab entry + mount; answers with the mount point. */
export async function setUpDrive(uuid: string, name: string): Promise<string> {
  return helper(['add', uuid, name]);
}

export async function removeDrive(name: string): Promise<void> {
  await helper(['remove', name]);
}

export async function ejectDrive(name: string): Promise<void> {
  await helper(['eject', name]);
}

export interface FolderListing {
  path: string;
  parent: string | null;
  folders: { name: string; path: string }[];
}

/** Where the folder picker starts: drives, desktop mounts (macOS: /Volumes), the user's home. */
export function folderStarts(home: string): { name: string; path: string }[] {
  const starts: { name: string; path: string }[] = [];
  for (const base of [DRIVE_BASE, '/media', '/mnt', '/Volumes']) {
    for (const folder of subfolders(base)) {
      if (base === '/mnt' && folder.path === DRIVE_BASE) continue;
      if (base === '/media') {
        // /media/<user>/<label>
        const inner = subfolders(folder.path);
        starts.push(...(inner.length ? inner : [folder]));
      } else {
        starts.push(folder);
      }
    }
  }
  starts.push({ name: 'Home', path: home });
  return starts;
}

function subfolders(dir: string): { name: string; path: string }[] {
  let names: fs.Dirent[];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return names
    .filter((d) => !d.name.startsWith('.'))
    .filter((d) => {
      if (d.isDirectory()) return true;
      if (!d.isSymbolicLink()) return false;
      try {
        return fs.statSync(path.join(dir, d.name)).isDirectory();
      } catch {
        return false;
      }
    })
    .map((d) => ({ name: d.name, path: path.join(dir, d.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
}

/** The folders inside one folder, for the picker. */
export function listFolder(dir: string): FolderListing {
  const resolved = path.resolve(dir);
  if (!fs.statSync(resolved).isDirectory()) throw new DriveError('Not a folder');
  fs.accessSync(resolved, fs.constants.R_OK | fs.constants.X_OK);
  const parent = path.dirname(resolved);
  return {
    path: resolved,
    parent: parent === resolved ? null : parent,
    folders: subfolders(resolved),
  };
}
