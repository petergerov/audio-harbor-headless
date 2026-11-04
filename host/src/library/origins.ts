import fs from 'node:fs';
import path from 'node:path';
import { DRIVE_BASE } from '../drives.js';
import { dataDir } from '../paths.js';

/**
 * Where a library folder's files come from when they are not Harbor's own (Linux): a disk
 * partition or an SMB share mounted by hand or by the desktop. Remembered while the folder is
 * connected, so it can be set up to mount on its own (/mnt/harbor, systemd automount) later —
 * after a restart too, when it is not mounted any more.
 */
export type SourceOrigin =
  | { kind: 'drive'; uuid: string; fsType: string; mountPoint: string }
  | { kind: 'share'; share: string; mountPoint: string };

/** File systems Harbor's helper mounts; mounts of anything else are not offered. */
const DRIVE_FS = new Set(['exfat', 'vfat', 'ntfs', 'ntfs3', 'fuseblk', 'ext2', 'ext3', 'ext4', 'btrfs', 'xfs']);
/** The system's own mounts: their folders are there with the system. */
const SYSTEM_MOUNTS = new Set(['/', '/boot', '/boot/firmware', '/usr', '/var', '/home']);

function originsPath(): string {
  return path.join(dataDir(), 'origins.json');
}

/** /proc/self/mounts escapes space, tab, newline and backslash as octal. */
function unescapeMount(text: string): string {
  return text.replace(/\\([0-7]{3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}

/** UUID of a block device, from the links in /dev/disk/by-uuid. */
function uuidOf(device: string): string | null {
  const dir = '/dev/disk/by-uuid';
  let real: string;
  try {
    real = fs.realpathSync(device);
  } catch {
    return null;
  }
  try {
    for (const name of fs.readdirSync(dir)) {
      try {
        if (fs.realpathSync(path.join(dir, name)) === real) return name;
      } catch {
        /* a link to a device that just went */
      }
    }
  } catch {
    /* no udev */
  }
  return null;
}

/**
 * The mount a folder lies on, as an origin Harbor could take over; null when it is Harbor's
 * already, the system's, or of a kind the helper does not mount (NFS, FUSE, …). Reads only
 * /proc and /dev — never the folder, which may hang.
 */
export function currentOrigin(folder: string): SourceOrigin | null {
  if (process.platform !== 'linux') return null;
  let text: string;
  try {
    text = fs.readFileSync('/proc/self/mounts', 'utf8');
  } catch {
    return null;
  }
  return originIn(text, folder, uuidOf);
}

/** currentOrigin from the text of /proc/self/mounts. */
export function originIn(
  text: string,
  folder: string,
  uuidOfDevice: (device: string) => string | null
): SourceOrigin | null {
  const resolved = path.resolve(folder);
  let best: { device: string; mountPoint: string; type: string } | null = null;
  for (const line of text.split('\n')) {
    const [rawDevice, rawTarget, type] = line.split(' ');
    if (!rawDevice || !rawTarget || !type || type === 'autofs') continue;
    const mountPoint = unescapeMount(rawTarget);
    const inside = mountPoint === '/' || resolved === mountPoint || resolved.startsWith(`${mountPoint}/`);
    // Later lines are mounted over earlier ones at the same place.
    if (inside && (!best || mountPoint.length >= best.mountPoint.length)) {
      best = { device: unescapeMount(rawDevice), mountPoint, type };
    }
  }
  if (!best || SYSTEM_MOUNTS.has(best.mountPoint)) return null;
  if (best.mountPoint === DRIVE_BASE || best.mountPoint.startsWith(`${DRIVE_BASE}/`)) return null;
  if ((best.type === 'cifs' || best.type === 'smb3') && best.device.startsWith('//')) {
    return { kind: 'share', share: best.device, mountPoint: best.mountPoint };
  }
  if (DRIVE_FS.has(best.type) && best.device.startsWith('/dev/')) {
    const uuid = uuidOfDevice(best.device);
    return uuid ? { kind: 'drive', uuid, fsType: best.type, mountPoint: best.mountPoint } : null;
  }
  return null;
}

/**
 * `//server/share/sub/folder` → server, share and the folder inside it that was mounted
 * (empty: the share itself); null when it is not one.
 */
export function splitShare(share: string): { server: string; share: string; subfolder: string } | null {
  const m = share.match(/^\/\/([^/]+)\/([^/]+)((?:\/[^/]+)*)\/?$/);
  return m ? { server: m[1]!, share: m[2]!, subfolder: m[3]!.replace(/^\//, '') } : null;
}

/** The origins of library folders, kept in origins.json in the data folder. */
export class SourceOrigins {
  private origins: Record<string, SourceOrigin>;

  constructor(private readonly file = originsPath()) {
    try {
      this.origins = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, SourceOrigin>;
    } catch {
      this.origins = {};
    }
  }

  get(root: string): SourceOrigin | null {
    return this.origins[path.resolve(root)] ?? null;
  }

  /** Notes where a connected folder's files come from now. */
  record(root: string): void {
    const key = path.resolve(root);
    const origin = currentOrigin(key);
    const before = this.origins[key];
    if (!origin) {
      // Readable, but on Harbor's own mount or the system disk now: nothing to offer.
      if (before) this.drop([key]);
      return;
    }
    if (JSON.stringify(before) === JSON.stringify(origin)) return;
    this.origins[key] = origin;
    this.save();
  }

  /** Forgets these folders (removed, or moved to /mnt/harbor). */
  drop(roots: string[]): void {
    let changed = false;
    for (const root of roots) changed = delete this.origins[path.resolve(root)] || changed;
    if (changed) this.save();
  }

  /** Keeps only the folders still in the library. */
  keep(roots: string[]): void {
    const wanted = new Set(roots.map((r) => path.resolve(r)));
    this.drop(Object.keys(this.origins).filter((r) => !wanted.has(r)));
  }

  private save(): void {
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(this.origins, null, 2)}\n`);
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.warn('Could not save library origins:', err);
    }
  }
}
