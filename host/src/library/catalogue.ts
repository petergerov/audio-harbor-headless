import crypto from 'node:crypto';
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

export class Catalogue {
  private db: DatabaseSync;

  constructor(dbPath = cataloguePath()) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.migrate();
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

    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      const files = walkAudioFiles(root);
      for (const file of files) {
        scanned += 1;
        const st = fs.statSync(file);
        const mtime = Math.floor(st.mtimeMs);
        if (mtimeMap.get(file) === mtime) continue;
        try {
          if (path.extname(file).toLowerCase() === '.iso' && isSacdIso(file)) {
            for (const sacd of listSacdTracks(file)) {
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

    this.db.exec(`INSERT INTO tracks_fts(tracks_fts) VALUES('rebuild')`);
    return { scanned, indexed };
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
      .all(`${q}*`, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => rowToTrack(r, this.labelsFor(String(r.catalogue_path))));
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
        id: crypto.createHash('sha1').update(`${artist}\0${title}`).digest('hex').slice(0, 16),
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
    for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (ent.name.startsWith('.')) continue;
      const full = path.join(folderPath, ent.name);
      if (ent.isDirectory()) {
        out.push({ name: ent.name, path: full, isDirectory: true, track: null });
      } else if (
        path.extname(ent.name).toLowerCase() === '.iso' &&
        isSacdIso(full)
      ) {
        // Present ISO like a folder so tracks are browsable.
        out.push({
          name: ent.name.replace(/\.iso$/i, ''),
          path: full,
          isDirectory: true,
          track: null,
        });
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

  getPlaylist(id: string): { id: string; name: string; paths: string[] } | null {
    return this.listPlaylists().find((p) => p.id === id) ?? null;
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
    if (sel.folder) {
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
      this.addPathsToPlaylist(id, [cataloguePathValue]);
      return;
    }
    if (edit.removeFromPlaylist && typeof edit.removeFromPlaylist === 'object') {
      const id = String((edit.removeFromPlaylist as { id?: string }).id ?? '');
      this.removePathsFromPlaylist(id, [cataloguePathValue]);
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
