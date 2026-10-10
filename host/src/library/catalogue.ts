import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseFile } from 'music-metadata';
import { artworkDir, cataloguePath } from '../paths.js';
import type { Album, Artist, AudioFormat, BrowseScope, Track } from '../types.js';
import { isSacdIso, listSacdTracks, parseSacdPath } from './sacd.js';

const AUDIO_EXT = new Set([
  '.flac',
  '.m4a',
  '.mp4',
  '.alac',
  '.wav',
  '.aiff',
  '.aif',
  '.aac',
  '.mp3',
  '.dsf',
  '.dff',
  '.iso',
]);

function formatFromExt(ext: string): AudioFormat {
  switch (ext.toLowerCase()) {
    case '.flac':
      return 'flac';
    case '.m4a':
    case '.mp4':
    case '.alac':
      return 'alac';
    case '.wav':
      return 'wav';
    case '.aiff':
    case '.aif':
      return 'aiff';
    case '.aac':
      return 'aac';
    case '.mp3':
      return 'mp3';
    case '.dsf':
      return 'dsf';
    case '.dff':
      return 'dff';
    case '.iso':
      return 'sacd';
    default:
      return 'unknown';
  }
}

function trackId(cataloguePathValue: string): string {
  return crypto.createHash('sha256').update(cataloguePathValue).digest('hex').slice(0, 32);
}

function albumId(artist: string, title: string): string {
  return crypto.createHash('sha1').update(`${artist}\0${title}`).digest('hex').slice(0, 16);
}

/** Stable UUID of a library root, from its path — the remotes' directory and folder IDs. */
export function rootUuid(root: string): string {
  const h = crypto.createHash('sha1').update(path.resolve(root)).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Whether `filePath` is one of `roots` or lies below one. */
export function isUnderRoots(filePath: string, roots: string[]): boolean {
  const resolved = path.resolve(filePath);
  return roots.some((r) => {
    const root = path.resolve(r);
    return resolved === root || resolved.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  });
}

/** Remote folder ID of a directory under `roots`: `rootUUID` or `rootUUID/rel/path`. */
export function encodeFolderId(roots: string[], folderPath: string): string | null {
  const resolved = path.resolve(folderPath);
  for (const root of roots) {
    const rel = path.relative(path.resolve(root), resolved);
    if (rel === '') return rootUuid(root);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue;
    return `${rootUuid(root)}/${rel.split(path.sep).join('/')}`;
  }
  return null;
}

/** The directory a remote folder ID names; null when it is not under `roots`. */
export function resolveFolderId(roots: string[], id: string): string | null {
  if (id.length < 36 || (id.length > 36 && id[36] !== '/')) return null;
  const uuid = id.slice(0, 36).toLowerCase();
  const root = roots.find((r) => rootUuid(r) === uuid);
  if (!root) return null;
  const parts = id.slice(37).split('/').filter(Boolean);
  if (parts.some((p) => p === '.' || p === '..' || p.includes(path.sep))) return null;
  const resolved = path.resolve(root, ...parts);
  return isUnderRoots(resolved, [root]) ? resolved : null;
}

/** FTS5 match for free text: each word a quoted prefix, so punctuation cannot break the syntax. */
function ftsQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `"${word.replaceAll('"', '""')}"*`)
    .join(' ');
}

/** `a/b` path under the root that holds `filePath`, for sorting and hints. */
function relativeUnder(roots: string[], filePath: string): string {
  const root = roots.find((r) => isUnderRoots(filePath, [r]));
  return root ? path.relative(path.resolve(root), path.resolve(filePath)).split(path.sep).join('/') : filePath;
}

/** A track the search matched, with what scope filters need. */
export interface SearchHit {
  cataloguePath: string;
  album: string;
  albumArtist: string;
  albumId: string;
}

/** A hit of the remote's folder search: a directory or a track, under a root. */
export type FolderHit =
  | { kind: 'directory'; path: string; relativePath: string }
  | { kind: 'track'; cataloguePath: string; relativePath: string };

function sacdToTrack(
  sacd: import('./sacd.js').SacdTrackInfo,
  fileSize: number
): Track {
  return {
    id: trackId(sacd.cataloguePath),
    cataloguePath: sacd.cataloguePath,
    title: sacd.title,
    artist: sacd.artist,
    album: sacd.album,
    albumArtist: sacd.albumArtist,
    trackNumber: sacd.number,
    discNumber: 1,
    year: sacd.year,
    durationSecs: sacd.durationSecs || null,
    sampleRate: sacd.sampleRateHz,
    bitDepth: 1,
    channels: sacd.channels,
    format: 'sacd',
    artworkHash: null,
    labels: sacd.isDst ? ['DST'] : [],
    fileSize,
  };
}

/** Emits `scanning` (true / false) when a scan of the roots starts and ends. */
export class Catalogue extends EventEmitter {
  private db: DatabaseSync;
  private scans = 0;
  /** Directories holding tracks (and those above them); rebuilt after a scan. */
  private directories: string[] | null = null;

  constructor(dbPath = cataloguePath()) {
    super();
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.migrate();
  }

  /** A scan of the roots is running. */
  get isScanning(): boolean {
    return this.scans > 0;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tracks (
        catalogue_path TEXT PRIMARY KEY,
        id TEXT NOT NULL,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        album TEXT NOT NULL,
        album_artist TEXT NOT NULL,
        track_number INTEGER,
        disc_number INTEGER,
        year INTEGER,
        duration_secs REAL,
        sample_rate INTEGER,
        bit_depth INTEGER,
        channels INTEGER,
        format TEXT NOT NULL,
        artwork_hash TEXT,
        file_size INTEGER,
        mtime INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS labels (
        catalogue_path TEXT NOT NULL,
        label TEXT NOT NULL,
        PRIMARY KEY (catalogue_path, label)
      );
      CREATE TABLE IF NOT EXISTS playlists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        paths_json TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
        title, artist, album, album_artist, catalogue_path,
        content='tracks', content_rowid='rowid'
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  async scanRoots(roots: string[]): Promise<{ scanned: number; indexed: number }> {
    this.scans += 1;
    if (this.scans === 1) this.emit('scanning', true);
    try {
      return await this.scan(roots);
    } finally {
      this.scans -= 1;
      this.directories = null;
      if (this.scans === 0) this.emit('scanning', false);
    }
  }

  private async scan(roots: string[]): Promise<{ scanned: number; indexed: number }> {
    let scanned = 0;
    let indexed = 0;
    const upsert = this.db.prepare(`
      INSERT INTO tracks (
        catalogue_path, id, title, artist, album, album_artist,
        track_number, disc_number, year, duration_secs, sample_rate, bit_depth,
        channels, format, artwork_hash, file_size, mtime
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?
      )
      ON CONFLICT(catalogue_path) DO UPDATE SET
        title=excluded.title, artist=excluded.artist, album=excluded.album,
        album_artist=excluded.album_artist, track_number=excluded.track_number,
        disc_number=excluded.disc_number, year=excluded.year,
        duration_secs=excluded.duration_secs, sample_rate=excluded.sample_rate,
        bit_depth=excluded.bit_depth, channels=excluded.channels, format=excluded.format,
        artwork_hash=excluded.artwork_hash, file_size=excluded.file_size, mtime=excluded.mtime
    `);

    const existing = this.db.prepare('SELECT catalogue_path, mtime FROM tracks').all() as Array<{
      catalogue_path: string;
      mtime: number;
    }>;
    const mtimeMap = new Map(existing.map((r) => [r.catalogue_path, r.mtime]));
    const seen = new Set<string>();
    const resolvedRoots = roots.map((r) => path.resolve(r));
    const scannedRoots: string[] = [];

    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      scannedRoots.push(path.resolve(root));
      const files = walkAudioFiles(root);
      for (const file of files) {
        scanned += 1;
        const st = fs.statSync(file);
        const mtime = Math.floor(st.mtimeMs);
        try {
          if (path.extname(file).toLowerCase() === '.iso' && isSacdIso(file)) {
            for (const sacd of listSacdTracks(file)) {
              seen.add(sacd.cataloguePath);
              if (mtimeMap.get(sacd.cataloguePath) === mtime) continue;
              const track = sacdToTrack(sacd, st.size);
              upsert.run(
                track.cataloguePath,
                track.id,
                track.title,
                track.artist,
                track.album,
                track.albumArtist,
                track.trackNumber,
                track.discNumber,
                track.year,
                track.durationSecs,
                track.sampleRate,
                track.bitDepth,
                track.channels,
                track.format,
                track.artworkHash,
                track.fileSize,
                mtime
              );
              if (sacd.isDst) {
                this.db
                  .prepare('INSERT OR IGNORE INTO labels (catalogue_path, label) VALUES (?, ?)')
                  .run(track.cataloguePath, 'DST');
              }
              indexed += 1;
            }
            continue;
          }
          seen.add(file);
          if (mtimeMap.get(file) === mtime) continue;
          const track = await readTrack(file, st.size);
          upsert.run(
            track.cataloguePath,
            track.id,
            track.title,
            track.artist,
            track.album,
            track.albumArtist,
            track.trackNumber,
            track.discNumber,
            track.year,
            track.durationSecs,
            track.sampleRate,
            track.bitDepth,
            track.channels,
            track.format,
            track.artworkHash,
            track.fileSize,
            mtime
          );
          indexed += 1;
        } catch {
          // skip unreadable
        }
      }
    }

    this.removeOrphanTracks(seen, resolvedRoots, scannedRoots);
    this.db.exec(`INSERT INTO tracks_fts(tracks_fts) VALUES('rebuild')`);
    return { scanned, indexed };
  }

  /**
   * Drop tracks deleted from disk (under a root we walked) or no longer under any
   * configured source. Roots that are temporarily missing are left alone.
   */
  private removeOrphanTracks(
    seen: Set<string>,
    resolvedRoots: string[],
    scannedRoots: string[]
  ): void {
    const under = (filePath: string, rootList: string[]): boolean => {
      const norm = path.resolve(filePath);
      return rootList.some((r) => norm === r || norm.startsWith(r + path.sep));
    };
    const fileOf = (cataloguePathValue: string): string =>
      parseSacdPath(cataloguePathValue)?.filePath ?? cataloguePathValue;

    const all = this.db.prepare('SELECT catalogue_path FROM tracks').all() as Array<{
      catalogue_path: string;
    }>;
    const orphans: string[] = [];
    for (const { catalogue_path: cp } of all) {
      const file = fileOf(cp);
      if (!under(file, resolvedRoots)) {
        orphans.push(cp);
        continue;
      }
      if (under(file, scannedRoots) && !seen.has(cp)) orphans.push(cp);
    }
    if (!orphans.length) return;

    const delTrack = this.db.prepare('DELETE FROM tracks WHERE catalogue_path = ?');
    const delLabel = this.db.prepare('DELETE FROM labels WHERE catalogue_path = ?');
    const orphanSet = new Set(orphans);
    this.db.exec('BEGIN');
    try {
      for (const cp of orphans) {
        delTrack.run(cp);
        delLabel.run(cp);
      }
      const playlists = this.db.prepare('SELECT id, paths_json FROM playlists').all() as Array<{
        id: string;
        paths_json: string;
      }>;
      const updatePl = this.db.prepare('UPDATE playlists SET paths_json = ? WHERE id = ?');
      for (const pl of playlists) {
        let paths: string[] = [];
        try {
          paths = JSON.parse(pl.paths_json) as string[];
        } catch {
          continue;
        }
        const next = paths.filter((p) => !orphanSet.has(p));
        if (next.length !== paths.length) updatePl.run(JSON.stringify(next), pl.id);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getTrack(cataloguePathValue: string): Track | null {
    const row = this.db
      .prepare('SELECT * FROM tracks WHERE catalogue_path = ?')
      .get(cataloguePathValue) as Record<string, unknown> | undefined;
    if (row) return rowToTrack(row, this.labelsFor(cataloguePathValue));

    // Folder browse can surface SACD ISO tracks before/without a library rescan.
    const parsed = parseSacdPath(cataloguePathValue);
    if (!parsed || !fs.existsSync(parsed.filePath)) return null;
    try {
      const st = fs.statSync(parsed.filePath);
      const sacd = listSacdTracks(parsed.filePath).find(
        (t) => t.cataloguePath === cataloguePathValue || t.number === parsed.track
      );
      return sacd ? sacdToTrack(sacd, st.size) : null;
    } catch {
      return null;
    }
  }

  listTracks(limit = 200, offset = 0): Track[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM tracks ORDER BY album_artist, album, track_number, title LIMIT ? OFFSET ?'
      )
      .all(limit, offset) as Array<Record<string, unknown>>;
    return rows.map((r) => rowToTrack(r, this.labelsFor(String(r.catalogue_path))));
  }

  search(query: string, limit = 50): Track[] {
    const q = query.trim();
    if (!q) return this.listTracks(limit, 0);
    const rows = this.db
      .prepare(
        `SELECT t.* FROM tracks_fts f
         JOIN tracks t ON t.rowid = f.rowid
         WHERE tracks_fts MATCH ?
         LIMIT ?`
      )
      .all(ftsQuery(q), limit) as Array<Record<string, unknown>>;
    return rows.map((r) => rowToTrack(r, this.labelsFor(String(r.catalogue_path))));
  }

  /** Every track the search finds for `query` — for filtering albums, artists and lists by it. */
  searchHits(query: string): SearchHit[] {
    const q = ftsQuery(query);
    if (!q) return [];
    const rows = this.db
      .prepare(
        `SELECT t.catalogue_path, t.album, t.album_artist FROM tracks_fts f
         JOIN tracks t ON t.rowid = f.rowid
         WHERE tracks_fts MATCH ?`
      )
      .all(q) as Array<{ catalogue_path: string; album: string; album_artist: string }>;
    return rows.map((r) => ({
      cataloguePath: r.catalogue_path,
      album: r.album,
      albumArtist: r.album_artist,
      albumId: albumId(r.album_artist, r.album),
    }));
  }

  /**
   * Directories (by name) and tracks (by the search) under every root, sorted by their path
   * under the root — the remote's Folders search.
   */
  searchFolders(roots: string[], query: string): FolderHit[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const hits: FolderHit[] = [];
    for (const hit of this.searchHits(query)) {
      const file = parseSacdPath(hit.cataloguePath)?.filePath ?? hit.cataloguePath;
      if (!isUnderRoots(file, roots)) continue;
      hits.push({ kind: 'track', cataloguePath: hit.cataloguePath, relativePath: relativeUnder(roots, hit.cataloguePath) });
    }
    const rootSet = new Set(roots.map((r) => path.resolve(r)));
    for (const dir of this.trackDirectories()) {
      if (rootSet.has(dir) || !isUnderRoots(dir, roots)) continue;
      if (!path.basename(dir).toLowerCase().includes(q)) continue;
      hits.push({ kind: 'directory', path: dir, relativePath: relativeUnder(roots, dir) });
    }
    return hits.sort((a, b) =>
      a.relativePath.localeCompare(b.relativePath, undefined, { numeric: true, sensitivity: 'base' })
    );
  }

  /** Directories that hold catalogued tracks, and every directory above them. */
  private trackDirectories(): string[] {
    if (!this.directories) {
      const dirs = new Set<string>();
      const rows = this.db.prepare('SELECT catalogue_path FROM tracks').all() as Array<{
        catalogue_path: string;
      }>;
      for (const { catalogue_path: cp } of rows) {
        let dir = path.dirname(path.resolve(parseSacdPath(cp)?.filePath ?? cp));
        while (!dirs.has(dir)) {
          dirs.add(dir);
          const up = path.dirname(dir);
          if (up === dir) break;
          dir = up;
        }
      }
      this.directories = [...dirs];
    }
    return this.directories;
  }

  albums(): Album[] {
    const rows = this.db
      .prepare(
        `SELECT album as title, album_artist as artist,
                MIN(year) as year, COUNT(*) as track_count,
                MAX(artwork_hash) as artwork_hash
         FROM tracks
         GROUP BY album_artist, album
         ORDER BY album_artist, album`
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => {
      const title = String(r.title);
      const artist = String(r.artist);
      return {
        id: albumId(artist, title),
        title,
        artist,
        year: r.year == null ? null : Number(r.year),
        trackCount: Number(r.track_count),
        artworkHash: r.artwork_hash ? String(r.artwork_hash) : null,
      };
    });
  }

  albumTracks(albumId: string): Track[] {
    const album = this.albums().find((a) => a.id === albumId);
    if (!album) return [];
    return this.tracksForAlbum(album.title, album.artist);
  }

  /** Tracks of the album that contains this path (for next/prev when a single song is tapped). */
  albumTracksForPath(cataloguePathValue: string): Track[] {
    const track = this.getTrack(cataloguePathValue);
    if (!track) return [];
    const siblings = this.tracksForAlbum(track.album, track.albumArtist);
    return siblings.length ? siblings : [track];
  }

  private tracksForAlbum(album: string, albumArtist: string): Track[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tracks WHERE album = ? AND album_artist = ?
         ORDER BY disc_number, track_number, title`
      )
      .all(album, albumArtist) as Array<Record<string, unknown>>;
    return rows.map((r) => rowToTrack(r, this.labelsFor(String(r.catalogue_path))));
  }

  artists(): Artist[] {
    const rows = this.db
      .prepare(
        `SELECT album_artist as name,
                COUNT(DISTINCT album) as album_count,
                COUNT(*) as track_count
         FROM tracks
         GROUP BY album_artist
         ORDER BY album_artist`
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      name: String(r.name),
      albumCount: Number(r.album_count),
      trackCount: Number(r.track_count),
    }));
  }

  artistTracks(name: string): Track[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tracks WHERE album_artist = ?
         ORDER BY album, disc_number, track_number, title`
      )
      .all(name) as Array<Record<string, unknown>>;
    return rows.map((r) => rowToTrack(r, this.labelsFor(String(r.catalogue_path))));
  }

  browseFolder(
    rootPaths: string[],
    folderPath?: string | null
  ): Array<{
    name: string;
    path: string;
    isDirectory: boolean;
    track: Track | null;
  }> {
    if (!folderPath) {
      return rootPaths
        .filter((r) => fs.existsSync(r))
        .map((r) => ({
          name: path.basename(r),
          path: r,
          isDirectory: true,
          track: null,
        }));
    }
    if (!isUnderRoots(folderPath, rootPaths)) return [];

    // Drill into SACD ISO as a virtual folder of tracks (#sacd/N).
    if (fs.existsSync(folderPath) && fs.statSync(folderPath).isFile()) {
      if (path.extname(folderPath).toLowerCase() === '.iso' && isSacdIso(folderPath)) {
        const size = fs.statSync(folderPath).size;
        return listSacdTracks(folderPath).map((sacd) => {
          const track = this.getTrack(sacd.cataloguePath) ?? sacdToTrack(sacd, size);
          const label = sacd.number
            ? `${String(sacd.number).padStart(2, '0')} ${sacd.title}`
            : sacd.title;
          return {
            name: label,
            path: sacd.cataloguePath,
            isDirectory: false,
            track,
          };
        });
      }
      return [];
    }

    if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) return [];
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    const out: Array<{
      name: string;
      path: string;
      isDirectory: boolean;
      track: Track | null;
    }> = [];

    // Count SACD ISOs so multi-disc folders can prefix track labels.
    let sacdIsoCount = 0;
    for (const ent of entries) {
      if (ent.name.startsWith('.') || !ent.isFile()) continue;
      const full = path.join(folderPath, ent.name);
      if (path.extname(ent.name).toLowerCase() === '.iso' && isSacdIso(full)) sacdIsoCount += 1;
    }

    for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (ent.name.startsWith('.')) continue;
      const full = path.join(folderPath, ent.name);
      if (ent.isDirectory()) {
        out.push({ name: ent.name, path: full, isDirectory: true, track: null });
      } else if (
        path.extname(ent.name).toLowerCase() === '.iso' &&
        isSacdIso(full)
      ) {
        // Inline disc tracks — no extra click through a virtual ISO folder.
        const size = fs.statSync(full).size;
        const discName = ent.name.replace(/\.iso$/i, '');
        for (const sacd of listSacdTracks(full)) {
          const track = this.getTrack(sacd.cataloguePath) ?? sacdToTrack(sacd, size);
          const trackLabel = sacd.number
            ? `${String(sacd.number).padStart(2, '0')} ${sacd.title}`
            : sacd.title;
          out.push({
            name: sacdIsoCount > 1 ? `${discName} · ${trackLabel}` : trackLabel,
            path: sacd.cataloguePath,
            isDirectory: false,
            track,
          });
        }
      } else if (AUDIO_EXT.has(path.extname(ent.name).toLowerCase())) {
        out.push({
          name: ent.name,
          path: full,
          isDirectory: false,
          track: this.getTrack(full),
        });
      }
    }
    return out;
  }

  browse(scope: BrowseScope, roots: string[], folderPath?: string | null) {
    switch (scope) {
      case 'albums':
        if (folderPath) {
          return this.albumTracks(folderPath).map((t) => ({
            ...t,
            cataloguePath: t.cataloguePath,
          }));
        }
        return this.albums();
      case 'artists':
        if (folderPath) {
          return this.artistTracks(folderPath).map((t) => ({
            ...t,
            cataloguePath: t.cataloguePath,
          }));
        }
        return this.artists();
      case 'folders':
        return this.browseFolder(roots, folderPath);
      case 'playlists':
        if (folderPath) {
          return this.playlistTracks(folderPath).map((t) => ({
            ...t,
            cataloguePath: t.cataloguePath,
          }));
        }
        return this.listPlaylists().map((p) => ({
          id: p.id,
          name: p.name,
          trackCount: p.paths.length,
          kind: 'playlist' as const,
        }));
      case 'labels':
        if (folderPath) {
          return this.tracksForLabel(folderPath);
        }
        return this.allLabels().map((name) => ({
          id: name,
          name,
          trackCount: this.tracksForLabel(name).length,
          kind: 'label' as const,
        }));
      default:
        return [];
    }
  }

  artworkFile(hash: string): string | null {
    const p = path.join(artworkDir(), `${hash}.jpg`);
    return fs.existsSync(p) ? p : null;
  }

  listPlaylists(): Array<{ id: string; name: string; paths: string[] }> {
    const rows = this.db.prepare('SELECT id, name, paths_json FROM playlists ORDER BY name').all() as Array<{
      id: string;
      name: string;
      paths_json: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      paths: JSON.parse(r.paths_json) as string[],
    }));
  }

  /** By id, in any letter case (the iOS app sends UUIDs upper case). */
  getPlaylist(id: string): { id: string; name: string; paths: string[] } | null {
    const want = id.toLowerCase();
    return this.listPlaylists().find((p) => p.id.toLowerCase() === want) ?? null;
  }

  playlistTracks(id: string): Track[] {
    const pl = this.getPlaylist(id);
    if (!pl) return [];
    return pl.paths
      .map((p) => this.getTrack(p))
      .filter((t): t is Track => Boolean(t));
  }

  createPlaylist(name: string, paths: string[] = []): { id: string; name: string; paths: string[] } {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('name required');
    const id = crypto.randomUUID();
    const unique = [...new Set(paths.filter((p) => Boolean(this.getTrack(p))))];
    this.db
      .prepare('INSERT INTO playlists (id, name, paths_json) VALUES (?, ?, ?)')
      .run(id, trimmed, JSON.stringify(unique));
    return { id, name: trimmed, paths: unique };
  }

  renamePlaylist(id: string, name: string): void {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('name required');
    const r = this.db.prepare('UPDATE playlists SET name = ? WHERE id = ?').run(trimmed, id);
    if (r.changes === 0) throw new Error('playlist not found');
  }

  deletePlaylist(id: string): void {
    const r = this.db.prepare('DELETE FROM playlists WHERE id = ?').run(id);
    if (r.changes === 0) throw new Error('playlist not found');
  }

  addPathsToPlaylist(id: string, paths: string[]): number {
    const row = this.db.prepare('SELECT paths_json FROM playlists WHERE id = ?').get(id) as
      | { paths_json: string }
      | undefined;
    if (!row) throw new Error('playlist not found');
    const current = JSON.parse(row.paths_json) as string[];
    let added = 0;
    for (const p of paths) {
      if (!this.getTrack(p) || current.includes(p)) continue;
      current.push(p);
      added += 1;
    }
    this.db.prepare('UPDATE playlists SET paths_json = ? WHERE id = ?').run(JSON.stringify(current), id);
    return added;
  }

  removePathsFromPlaylist(id: string, paths: string[]): void {
    const row = this.db.prepare('SELECT paths_json FROM playlists WHERE id = ?').get(id) as
      | { paths_json: string }
      | undefined;
    if (!row) throw new Error('playlist not found');
    const drop = new Set(paths);
    const next = (JSON.parse(row.paths_json) as string[]).filter((p) => !drop.has(p));
    this.db.prepare('UPDATE playlists SET paths_json = ? WHERE id = ?').run(JSON.stringify(next), id);
  }

  allLabels(): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT label FROM labels ORDER BY label COLLATE NOCASE')
      .all() as Array<{ label: string }>;
    return rows.map((r) => r.label);
  }

  tracksForLabel(label: string): Track[] {
    const rows = this.db
      .prepare(
        `SELECT t.* FROM tracks t
         INNER JOIN labels l ON l.catalogue_path = t.catalogue_path
         WHERE l.label = ?
         ORDER BY t.album_artist, t.album, t.disc_number, t.track_number, t.title`
      )
      .all(label) as Array<Record<string, unknown>>;
    return rows.map((r) => rowToTrack(r, this.labelsFor(String(r.catalogue_path))));
  }

  addLabelToPaths(label: string, paths: string[]): number {
    const name = label.trim();
    if (!name) throw new Error('name required');
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO labels (catalogue_path, label) VALUES (?, ?)'
    );
    let n = 0;
    for (const p of paths) {
      if (!this.getTrack(p)) continue;
      const r = stmt.run(p, name);
      if (r.changes > 0) n += 1;
    }
    return n;
  }

  removeLabelFromPaths(label: string, paths: string[]): void {
    const name = label.trim();
    const stmt = this.db.prepare(
      'DELETE FROM labels WHERE catalogue_path = ? AND label = ?'
    );
    for (const p of paths) stmt.run(p, name);
  }

  /** Remove a label from every track. Returns how many rows were deleted. */
  deleteLabel(label: string): number {
    const name = label.trim();
    if (!name) return 0;
    const r = this.db.prepare('DELETE FROM labels WHERE label = ?').run(name);
    return Number(r.changes ?? 0);
  }

  renameLabel(from: string, to: string): number {
    const prev = from.trim();
    const next = to.trim();
    if (!prev || !next) throw new Error('name required');
    if (prev === next) return 0;
    // Move associations; ignore conflicts already tagged with the new name.
    const rows = this.db
      .prepare('SELECT catalogue_path FROM labels WHERE label = ?')
      .all(prev) as Array<{ catalogue_path: string }>;
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO labels (catalogue_path, label) VALUES (?, ?)'
    );
    const del = this.db.prepare('DELETE FROM labels WHERE catalogue_path = ? AND label = ?');
    let n = 0;
    for (const row of rows) {
      insert.run(row.catalogue_path, next);
      del.run(row.catalogue_path, prev);
      n += 1;
    }
    return n;
  }

  /** Expand album / artist / folder / paths into catalogue paths (like Mac TrackMenuItems). */
  resolveSelectionPaths(
    roots: string[],
    sel: {
      paths?: string[];
      cataloguePath?: string;
      albumId?: string;
      artist?: string;
      folder?: string;
    }
  ): string[] {
    const out: string[] = [];
    const push = (p: string) => {
      if (p && this.getTrack(p) && !out.includes(p)) out.push(p);
    };
    if (sel.cataloguePath) push(sel.cataloguePath);
    if (Array.isArray(sel.paths)) for (const p of sel.paths) push(p);
    if (sel.albumId) {
      for (const t of this.albumTracks(sel.albumId)) push(t.cataloguePath);
    }
    if (sel.artist) {
      for (const t of this.artistTracks(sel.artist)) push(t.cataloguePath);
    }
    if (sel.folder && isUnderRoots(sel.folder, roots)) {
      // Playing an SACD ISO "folder" → all virtual tracks on that disc.
      if (
        fs.existsSync(sel.folder) &&
        fs.statSync(sel.folder).isFile() &&
        path.extname(sel.folder).toLowerCase() === '.iso' &&
        isSacdIso(sel.folder)
      ) {
        for (const sacd of listSacdTracks(sel.folder)) push(sacd.cataloguePath);
      } else {
        const entries = this.browseFolder(roots, sel.folder);
        for (const e of entries) {
          if (e.track) push(e.track.cataloguePath);
          // Nested ISO presented as directory — expand its tracks too.
          if (e.isDirectory && e.path.toLowerCase().endsWith('.iso')) {
            for (const sacd of listSacdTracks(e.path)) push(sacd.cataloguePath);
          }
        }
        for (const file of walkAudioFiles(sel.folder)) {
          if (path.extname(file).toLowerCase() === '.iso' && isSacdIso(file)) {
            for (const sacd of listSacdTracks(file)) push(sacd.cataloguePath);
          } else {
            push(file);
          }
        }
        const prefix = sel.folder.endsWith(path.sep) ? sel.folder : sel.folder + path.sep;
        const rows = this.db
          .prepare(
            `SELECT catalogue_path FROM tracks
             WHERE catalogue_path = ? OR catalogue_path LIKE ? OR catalogue_path LIKE ?`
          )
          .all(sel.folder, prefix + '%', prefix + '%' + '#sacd/%') as Array<{
          catalogue_path: string;
        }>;
        for (const r of rows) push(r.catalogue_path);
      }
    }
    return out;
  }

  trackOptions(cataloguePathValue: string): {
    cataloguePath: string;
    playlists: Array<{ id: string; name: string; containsTrack: boolean }>;
    labels: string[];
    trackLabels: string[];
  } | null {
    if (!this.getTrack(cataloguePathValue)) return null;
    const trackLabels = this.labelsFor(cataloguePathValue);
    const playlists = this.listPlaylists().map((p) => ({
      id: p.id,
      name: p.name,
      containsTrack: p.paths.includes(cataloguePathValue),
    }));
    return {
      cataloguePath: cataloguePathValue,
      playlists,
      labels: this.allLabels(),
      trackLabels,
    };
  }

  applyTrackEdit(cataloguePathValue: string, edit: Record<string, unknown>): void {
    if (!this.getTrack(cataloguePathValue)) throw new Error('track not found');
    if (edit.addToPlaylist && typeof edit.addToPlaylist === 'object') {
      const id = String((edit.addToPlaylist as { id?: string }).id ?? '');
      this.addPathsToPlaylist(this.getPlaylist(id)?.id ?? id, [cataloguePathValue]);
      return;
    }
    if (edit.removeFromPlaylist && typeof edit.removeFromPlaylist === 'object') {
      const id = String((edit.removeFromPlaylist as { id?: string }).id ?? '');
      this.removePathsFromPlaylist(this.getPlaylist(id)?.id ?? id, [cataloguePathValue]);
      return;
    }
    if (edit.addToNewPlaylist && typeof edit.addToNewPlaylist === 'object') {
      const name = String((edit.addToNewPlaylist as { name?: string }).name ?? '').trim();
      this.createPlaylist(name, [cataloguePathValue]);
      return;
    }
    if (edit.addLabel && typeof edit.addLabel === 'object') {
      const name = String((edit.addLabel as { name?: string }).name ?? '').trim();
      this.addLabelToPaths(name, [cataloguePathValue]);
      return;
    }
    if (edit.removeLabel && typeof edit.removeLabel === 'object') {
      const name = String((edit.removeLabel as { name?: string }).name ?? '').trim();
      this.removeLabelFromPaths(name, [cataloguePathValue]);
      return;
    }
    throw new Error('unknown edit');
  }

  private labelsFor(cataloguePathValue: string): string[] {
    const rows = this.db
      .prepare('SELECT label FROM labels WHERE catalogue_path = ? ORDER BY label COLLATE NOCASE')
      .all(cataloguePathValue) as Array<{ label: string }>;
    return rows.map((r) => r.label);
  }
}

function walkAudioFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (AUDIO_EXT.has(path.extname(ent.name).toLowerCase())) out.push(full);
    }
  }
  return out;
}

async function readTrack(file: string, fileSize: number): Promise<Track> {
  const ext = path.extname(file);
  const format = formatFromExt(ext);
  let title = path.basename(file, ext);
  let artist = 'Unknown Artist';
  let album = 'Unknown Album';
  let albumArtist = artist;
  let trackNumber: number | null = null;
  let discNumber: number | null = null;
  let year: number | null = null;
  let durationSecs: number | null = null;
  let sampleRate: number | null = null;
  let bitDepth: number | null = null;
  let channels: number | null = null;
  let artworkHash: string | null = null;

  if (format !== 'dsf' && format !== 'dff' && format !== 'sacd') {
    try {
      const meta = await parseFile(file, { duration: true });
      title = meta.common.title ?? title;
      artist = meta.common.artist ?? artist;
      album = meta.common.album ?? album;
      albumArtist = meta.common.albumartist ?? artist;
      trackNumber = meta.common.track?.no ?? null;
      discNumber = meta.common.disk?.no ?? null;
      year = meta.common.year ?? null;
      durationSecs = meta.format.duration ?? null;
      sampleRate = meta.format.sampleRate ?? null;
      bitDepth = meta.format.bitsPerSample ?? null;
      channels = meta.format.numberOfChannels ?? null;
      const pic = meta.common.picture?.[0];
      if (pic?.data) {
        artworkHash = crypto.createHash('sha1').update(pic.data).digest('hex');
        const dest = path.join(artworkDir(), `${artworkHash}.jpg`);
        if (!fs.existsSync(dest)) fs.writeFileSync(dest, pic.data);
      }
    } catch {
      // keep filename defaults
    }
  }

  const cataloguePathValue = file;
  return {
    id: trackId(cataloguePathValue),
    cataloguePath: cataloguePathValue,
    title,
    artist,
    album,
    albumArtist,
    trackNumber,
    discNumber,
    year,
    durationSecs,
    sampleRate,
    bitDepth,
    channels,
    format,
    artworkHash,
    labels: [],
    fileSize,
  };
}

function rowToTrack(row: Record<string, unknown>, labels: string[]): Track {
  return {
    id: String(row.id),
    cataloguePath: String(row.catalogue_path),
    title: String(row.title),
    artist: String(row.artist),
    album: String(row.album),
    albumArtist: String(row.album_artist),
    trackNumber: row.track_number == null ? null : Number(row.track_number),
    discNumber: row.disc_number == null ? null : Number(row.disc_number),
    year: row.year == null ? null : Number(row.year),
    durationSecs: row.duration_secs == null ? null : Number(row.duration_secs),
    sampleRate: row.sample_rate == null ? null : Number(row.sample_rate),
    bitDepth: row.bit_depth == null ? null : Number(row.bit_depth),
    channels: row.channels == null ? null : Number(row.channels),
    format: String(row.format) as AudioFormat,
    artworkHash: row.artwork_hash ? String(row.artwork_hash) : null,
    labels,
    fileSize: row.file_size == null ? null : Number(row.file_size),
  };
}
