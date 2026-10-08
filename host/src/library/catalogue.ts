import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseFile } from 'music-metadata';
import { artworkDir, cataloguePath } from '../paths.js';
import type { Album, Artist, AudioFormat, BrowseScope, Track } from '../types.js';

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
    return row ? rowToTrack(row, this.labelsFor(cataloguePathValue)) : null;
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
    const rows = this.db
      .prepare(
        `SELECT * FROM tracks WHERE album = ? AND album_artist = ?
         ORDER BY disc_number, track_number, title`
      )
      .all(album.title, album.artist) as Array<Record<string, unknown>>;
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
        return this.albums();
      case 'artists':
        return this.artists();
      case 'folders':
        return this.browseFolder(roots, folderPath);
      default:
        return [];
    }
  }

  artworkFile(hash: string): string | null {
    const p = path.join(artworkDir(), `${hash}.jpg`);
    return fs.existsSync(p) ? p : null;
  }

  private labelsFor(cataloguePathValue: string): string[] {
    const rows = this.db
      .prepare('SELECT label FROM labels WHERE catalogue_path = ?')
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
