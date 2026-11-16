import fs from 'node:fs';
import path from 'node:path';
import { AUDIO_EXT } from '../library/catalogue.js';
import type { Track } from '../types.js';
import { readFlacTags, writeFlacTags } from './flacTags.js';

/** Raw takes wait here (hidden: the library scan skips dot folders). */
export const TAKES_DIR = '.takes';
/** A raw take written into its files and kept (Keep Raw Take); `.raw.wav` is one still to write. */
export const KEPT_SUFFIX = '.kept.wav';

const isRawTake = (name: string) => name.endsWith('.raw.wav') || name.endsWith(KEPT_SUFFIX);

export class RecordingFilesError extends Error {}

/** What the library offers the recordings folder. */
export interface RecordingsLibrary {
  getTrack(cataloguePath: string): Track | null;
  /** Tracks, labels and playlist entries follow a rename or move. */
  movePaths(from: string, to: string): number;
  /** Tracks deleted from disk leave the library. */
  forgetPaths(target: string): number;
  /** Reads changed files again (new tags). */
  rescan(): Promise<unknown>;
  /** Whether a path lies inside a library folder (can be played). */
  inLibrary(p: string): boolean;
}

export interface RecordingEntry {
  name: string;
  /** Relative to the recordings folder, `/`-separated. */
  path: string;
  kind: 'folder' | 'audio' | 'file' | 'raw';
  bytes: number;
  modified: number;
  /** Folders: what is directly inside. */
  folders?: number;
  tracks?: number;
  /** Audio: from the library when it knows the file. */
  title?: string;
  seconds?: number | null;
  sampleRate?: number | null;
  bits?: number | null;
  format?: string;
  /** Absolute path, to play it (only when it is in the library). */
  cataloguePath?: string;
}

export interface RecordingListing {
  /** The folder shown, relative ('' = the recordings folder). */
  path: string;
  /** The recordings folder on the host. */
  root: string;
  /** Absolute path of the folder shown (play it as a folder). */
  absolute: string;
  /** Takes here show up in the library and can be played. */
  inLibrary: boolean;
  entries: RecordingEntry[];
  /** Kept raw takes (Keep Raw Take): only at the top. */
  raw: RecordingEntry[];
}

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

/** A name for a file or folder: one path segment, no hidden names, nothing the file systems refuse. */
function cleanName(name: unknown): string {
  const n = String(name ?? '')
    .replace(/[\u0000-\u001f]/g, '')
    .trim();
  if (!n || n === '.' || n === '..') throw new RecordingFilesError('Enter a name');
  if (n.startsWith('.')) throw new RecordingFilesError('A name cannot start with a dot');
  if (/[/\\:]/.test(n)) throw new RecordingFilesError('A name cannot contain / \\ or :');
  if (Buffer.byteLength(n) > 240) throw new RecordingFilesError('That name is too long');
  return n;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.promises.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * The recordings folder as a small file manager for the remote: list, new folder, rename,
 * move, delete. Everything stays inside the recordings folder; the library follows (labels and
 * playlists move with a file), and a rename retags the recorder's FLACs (title / album).
 */
export class RecordingFiles {
  constructor(
    private readonly rootDir: () => string,
    private readonly library: RecordingsLibrary
  ) {}

  /** `rel` as an absolute path inside the recordings folder (raw takes only when `raw`). */
  private resolve(rel: unknown, opts: { raw?: boolean } = {}): string {
    const root = path.resolve(this.rootDir());
    const parts = String(rel ?? '')
      .split('/')
      .filter(Boolean);
    for (const [i, p] of parts.entries()) {
      if (p === '.' || p === '..' || p.includes('\\')) throw new RecordingFilesError('Not in the recordings folder');
      const rawTake = opts.raw && i === 0 && p === TAKES_DIR && parts.length === 2 && isRawTake(parts[1]!);
      if (p.startsWith('.') && !rawTake) throw new RecordingFilesError('Not in the recordings folder');
    }
    const abs = path.resolve(root, ...parts);
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new RecordingFilesError('Not in the recordings folder');
    return abs;
  }

  private relOf(abs: string): string {
    return path.relative(path.resolve(this.rootDir()), abs).split(path.sep).join('/');
  }

  async list(rel = ''): Promise<RecordingListing> {
    const root = path.resolve(this.rootDir());
    const dir = this.resolve(rel);
    let dirents: fs.Dirent[] = [];
    try {
      dirents = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (dir !== root || (err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new RecordingFilesError(`Cannot open ${this.relOf(dir) || 'the recordings folder'}`);
      }
    }
    const entries: RecordingEntry[] = [];
    for (const d of dirents) {
      if (d.name.startsWith('.')) continue;
      const abs = path.join(dir, d.name);
      let st: fs.Stats;
      try {
        st = await fs.promises.stat(abs);
      } catch {
        continue;
      }
      const base = { name: d.name, path: this.relOf(abs), bytes: st.size, modified: st.mtimeMs };
      if (st.isDirectory()) {
        let folders = 0;
        let tracks = 0;
        let bytes = 0;
        for (const inner of await fs.promises.readdir(abs, { withFileTypes: true }).catch(() => [] as fs.Dirent[])) {
          if (inner.name.startsWith('.')) continue;
          if (inner.isDirectory()) folders += 1;
          else if (AUDIO_EXT.has(path.extname(inner.name).toLowerCase())) tracks += 1;
          if (inner.isFile()) bytes += (await fs.promises.stat(path.join(abs, inner.name)).catch(() => null))?.size ?? 0;
        }
        entries.push({ ...base, kind: 'folder', bytes, folders, tracks });
      } else if (st.isFile()) {
        const audio = AUDIO_EXT.has(path.extname(d.name).toLowerCase());
        if (!audio) {
          entries.push({ ...base, kind: 'file' });
          continue;
        }
        const track = this.library.getTrack(abs);
        entries.push({
          ...base,
          kind: 'audio',
          title: track?.title || undefined,
          seconds: track?.durationSecs ?? null,
          sampleRate: track?.sampleRate ?? null,
          bits: track?.bitDepth ?? null,
          format: track?.format ?? path.extname(d.name).slice(1).toLowerCase(),
          cataloguePath: track && track.available !== false ? abs : undefined,
        });
      }
    }
    // Folders first (newest take on top: names start with the date), then files by name.
    const folders = entries.filter((e) => e.kind === 'folder').sort((a, b) => byName(b, a));
    const files = entries.filter((e) => e.kind !== 'folder').sort(byName);

    const raw: RecordingEntry[] = [];
    if (dir === root) {
      const takes = path.join(root, TAKES_DIR);
      for (const name of await fs.promises.readdir(takes).catch(() => [] as string[])) {
        if (!isRawTake(name)) continue;
        const st = await fs.promises.stat(path.join(takes, name)).catch(() => null);
        if (!st?.isFile()) continue;
        raw.push({ name, path: `${TAKES_DIR}/${name}`, kind: 'raw', bytes: st.size, modified: st.mtimeMs });
      }
      raw.sort((a, b) => byName(b, a));
    }
    return {
      path: this.relOf(dir),
      root,
      absolute: dir,
      inLibrary: this.library.inLibrary(dir),
      entries: [...folders, ...files],
      raw,
    };
  }

  /** Every folder below the recordings folder, for a Move picker. */
  async folders(): Promise<Array<{ path: string; name: string; depth: number }>> {
    const out: Array<{ path: string; name: string; depth: number }> = [];
    const walk = async (abs: string, depth: number) => {
      const inner = await fs.promises.readdir(abs, { withFileTypes: true }).catch(() => [] as fs.Dirent[]);
      for (const d of inner.filter((x) => x.isDirectory() && !x.name.startsWith('.')).sort(byName)) {
        const child = path.join(abs, d.name);
        out.push({ path: this.relOf(child), name: d.name, depth });
        if (depth < 8 && out.length < 2000) await walk(child, depth + 1);
      }
    };
    await walk(path.resolve(this.rootDir()), 1);
    return out;
  }

  async createFolder(parentRel: string, name: unknown): Promise<string> {
    const parent = this.resolve(parentRel);
    const dir = path.join(parent, cleanName(name));
    if (await exists(dir)) throw new RecordingFilesError('There is already something with that name');
    await fs.promises.mkdir(dir, { recursive: true });
    return this.relOf(dir);
  }

  /**
   * Renames a file or folder in place. An audio file keeps its extension; the recorder's FLACs
   * take the new name as TITLE, the ones directly in a renamed folder as ALBUM.
   */
  async rename(rel: string, name: unknown): Promise<string> {
    const from = this.resolve(rel);
    if (from === path.resolve(this.rootDir())) throw new RecordingFilesError('The recordings folder itself cannot be renamed here');
    const st = await fs.promises.stat(from).catch(() => null);
    if (!st) throw new RecordingFilesError('Not found');
    let next = cleanName(name);
    const ext = path.extname(from);
    if (st.isFile() && ext && path.extname(next).toLowerCase() !== ext.toLowerCase()) next += ext;
    const to = path.join(path.dirname(from), next);
    if (to === from) return rel;
    // Same name in other letter case (case-insensitive disks): fine, it is the same entry.
    if (to.toLowerCase() !== from.toLowerCase() && (await exists(to))) {
      throw new RecordingFilesError('There is already something with that name');
    }
    await fs.promises.rename(from, to);
    this.library.movePaths(from, to);

    let retagged = false;
    if (st.isFile() && ext.toLowerCase() === '.flac') {
      retagged = await this.retag(to, { TITLE: path.basename(next, ext) });
    } else if (st.isDirectory()) {
      for (const inner of await fs.promises.readdir(to).catch(() => [] as string[])) {
        if (inner.startsWith('.') || path.extname(inner).toLowerCase() !== '.flac') continue;
        retagged = (await this.retag(path.join(to, inner), { ALBUM: next })) || retagged;
      }
    }
    if (retagged) void this.library.rescan().catch(() => undefined);
    return this.relOf(to);
  }

  /** Moves files and folders into `toRel` (a folder in the recordings folder). */
  async move(rels: string[], toRel: string): Promise<number> {
    const target = this.resolve(toRel);
    const st = await fs.promises.stat(target).catch(() => null);
    if (!st?.isDirectory()) throw new RecordingFilesError('Move into a folder');
    const sources = rels.map((r) => this.resolve(r));
    for (const from of sources) {
      if (from === path.resolve(this.rootDir())) throw new RecordingFilesError('The recordings folder cannot be moved');
      if (target === from || target.startsWith(from + path.sep)) {
        throw new RecordingFilesError('A folder cannot go into itself');
      }
      if (path.dirname(from) === target) continue;
      if (await exists(path.join(target, path.basename(from)))) {
        throw new RecordingFilesError(`${path.basename(from)} is already there`);
      }
    }
    let moved = 0;
    for (const from of sources) {
      if (path.dirname(from) === target) continue;
      const to = path.join(target, path.basename(from));
      try {
        await fs.promises.rename(from, to);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
        // Another disk below the recordings folder: copy, then remove.
        await fs.promises.cp(from, to, { recursive: true, errorOnExist: true, force: false });
        await fs.promises.rm(from, { recursive: true, force: true });
      }
      this.library.movePaths(from, to);
      moved += 1;
    }
    return moved;
  }

  /** Deletes files and folders (and kept raw takes) for good. */
  async remove(rels: string[]): Promise<number> {
    const root = path.resolve(this.rootDir());
    const targets = rels.map((r) => this.resolve(r, { raw: true }));
    if (targets.some((t) => t === root)) throw new RecordingFilesError('The recordings folder itself cannot be deleted');
    let removed = 0;
    for (const abs of targets) {
      if (!(await exists(abs))) continue;
      await fs.promises.rm(abs, { recursive: true, force: true });
      this.library.forgetPaths(abs);
      removed += 1;
    }
    return removed;
  }

  /** Writes tags into a FLAC the recorder made (vendor "Audio Harbor"); others stay as they are. */
  private async retag(file: string, patch: Record<string, string>): Promise<boolean> {
    try {
      const tags = readFlacTags(file);
      // Only takes: their TITLE / ALBUM came from the recorder ("Track 01", "Recording …").
      if (tags.ARTIST !== 'S/PDIF In' && !tags.COMMENT?.includes('Audio Harbor')) return false;
      await writeFlacTags(file, patch);
      return true;
    } catch (err) {
      console.warn(`Recording: could not retag ${file}: ${(err as Error).message}`);
      return false;
    }
  }
}
