import path from 'node:path';
import { encodeFolderId, resolveFolderId, rootUuid, type Catalogue } from '../library/catalogue.js';
import type { QueueSource, Track } from '../types.js';
import { toUuid, trackDto, wirePlaylistId } from './wire.js';

type BrowseItem = Record<string, unknown>;

export interface BrowseResult {
  items: BrowseItem[];
  hasMore: boolean;
}

/** What `browse` asks for (Swift BrowseRequest), as decoded JSON. */
export interface BrowseRequest {
  scope?: unknown;
  parentID?: unknown;
  offset?: unknown;
  limit?: unknown;
  query?: unknown;
}

const NOTHING: BrowseResult = { items: [], hasMore: false };

/** `offset`…`offset + limit` of `list`; entries `item` cannot show are left out. */
function page<T>(list: T[], offset: number, limit: number, item: (entry: T) => BrowseItem | null): BrowseResult {
  const slice = list.slice(offset, offset + limit + 1);
  return {
    items: slice.slice(0, limit).map(item).filter((i): i is BrowseItem => i !== null),
    hasMore: slice.length > limit,
  };
}

const trackItem = (track: Track): BrowseItem => ({ track: trackDto(track) });

/** By catalogue id or by the UUID the app got for it (any letter case). */
export function findAlbum(catalogue: Catalogue, id: string) {
  const want = id.toLowerCase();
  return catalogue.albums().find((a) => a.id === want || toUuid(a.id) === want) ?? null;
}

/** By id or by the UUID the app got for it (any letter case). */
export function findPlaylist(catalogue: Catalogue, id: string) {
  const want = id.toLowerCase();
  return catalogue.getPlaylist(id) ?? catalogue.listPlaylists().find((p) => toUuid(p.id) === want) ?? null;
}

/**
 * One page of a scope. With a query, like the Mac's search field: albums, artists and playlists
 * with a matching track (a playlist also by its name), and only the matching tracks inside them;
 * Folders searches every root. `labels` / `labelTracks` are this host's own scopes.
 */
export function browseLibrary(catalogue: Catalogue, roots: string[], request: BrowseRequest): BrowseResult {
  const offset = Math.max(0, Math.floor(Number(request.offset) || 0));
  const limit = Math.min(Math.max(1, Math.floor(Number(request.limit) || 50)), 200);
  const query = typeof request.query === 'string' ? request.query.trim() : '';
  const parentID = typeof request.parentID === 'string' ? request.parentID : '';
  const hits = query ? catalogue.searchHits(query) : null;
  const paths = hits ? new Set(hits.map((h) => h.cataloguePath)) : null;
  const visible = (tracks: Track[]) => (paths ? tracks.filter((t) => paths.has(t.cataloguePath)) : tracks);
  const named = (name: string) => query !== '' && name.toLowerCase().includes(query.toLowerCase());

  switch (request.scope) {
    case 'albums': {
      const ids = hits ? new Set(hits.map((h) => h.albumId)) : null;
      const albums = catalogue.albums().filter((a) => !ids || ids.has(a.id));
      return page(albums, offset, limit, (a) => ({
        album: { id: toUuid(a.id), title: a.title, artist: a.artist, trackCount: a.trackCount, artworkHash: a.artworkHash },
      }));
    }
    case 'artists': {
      const counts = new Map<string, number>();
      for (const hit of hits ?? []) counts.set(hit.albumArtist, (counts.get(hit.albumArtist) ?? 0) + 1);
      const artists = catalogue
        .artists()
        .map((a) => ({ name: a.name, trackCount: hits ? (counts.get(a.name) ?? 0) : a.trackCount }))
        .filter((a) => a.trackCount > 0);
      return page(artists, offset, limit, (artist) => ({ artist }));
    }
    case 'playlists': {
      const list = catalogue.listPlaylists().filter((p) => !paths || named(p.name) || p.paths.some((x) => paths.has(x)));
      return page(list, offset, limit, (p) => ({
        playlist: { id: wirePlaylistId(p.id), name: p.name, trackCount: p.paths.length },
      }));
    }
    case 'albumTracks': {
      const album = findAlbum(catalogue, parentID);
      return album ? page(visible(catalogue.albumTracks(album.id)), offset, limit, trackItem) : NOTHING;
    }
    case 'artistTracks':
      return parentID ? page(visible(catalogue.artistTracks(parentID)), offset, limit, trackItem) : NOTHING;
    case 'playlistTracks': {
      const playlist = findPlaylist(catalogue, parentID);
      if (!playlist) return NOTHING;
      const tracks = catalogue.playlistTracks(playlist.id);
      return page(named(playlist.name) ? tracks : visible(tracks), offset, limit, trackItem);
    }
    case 'folders':
      return query
        ? searchFolders(catalogue, roots, query, offset, limit)
        : browseFolders(catalogue, roots, parentID, offset, limit);
    case 'labels': {
      const labels = catalogue
        .allLabels()
        .map((name) => ({ name, tracks: catalogue.tracksForLabel(name) }))
        .filter((l) => !paths || named(l.name) || visible(l.tracks).length > 0);
      return page(labels, offset, limit, (l) => ({ label: { name: l.name, trackCount: l.tracks.length } }));
    }
    case 'labelTracks':
      return parentID ? page(visible(catalogue.tracksForLabel(parentID)), offset, limit, trackItem) : NOTHING;
    default:
      return NOTHING;
  }
}

/** The roots, or one directory of them: subdirectories and catalogued tracks. */
function browseFolders(
  catalogue: Catalogue,
  roots: string[],
  parentID: string,
  offset: number,
  limit: number
): BrowseResult {
  if (!parentID) {
    return page(catalogue.browseFolder(roots, null), offset, limit, (root) => ({
      folder: { id: rootUuid(root.path), name: root.name, childHint: root.path },
    }));
  }
  const folder = resolveFolderId(roots, parentID);
  if (!folder) return NOTHING;
  return page(catalogue.browseFolder(roots, folder), offset, limit, (entry) => {
    if (entry.isDirectory) {
      const id = encodeFolderId(roots, entry.path);
      return id ? { folder: { id, name: entry.name, childHint: 'Folder' } } : null;
    }
    return entry.track ? trackItem(entry.track) : null;
  });
}

/** Directories by name and tracks by the search, across every root (the Mac's Directories search). */
function searchFolders(catalogue: Catalogue, roots: string[], query: string, offset: number, limit: number): BrowseResult {
  return page(catalogue.searchFolders(roots, query), offset, limit, (hit) => {
    if (hit.kind === 'directory') {
      const id = encodeFolderId(roots, hit.path);
      return id ? { folder: { id, name: path.basename(hit.path), childHint: hit.relativePath } } : null;
    }
    const track = catalogue.getTrack(hit.cataloguePath);
    return track ? trackItem(track) : null;
  });
}

/** What a `playSelection` for an album, artist, playlist, folder or label queues; null when it names nothing. */
export function resolveSelection(
  catalogue: Catalogue,
  roots: string[],
  selection: Record<string, unknown>
): { tracks: Track[]; source: QueueSource } | null {
  const arg = (key: string) => {
    const value = selection[key];
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  };
  const queue = (tracks: Track[], source: QueueSource) => (tracks.length ? { tracks, source } : null);

  const album = arg('album');
  if (album) {
    const found = findAlbum(catalogue, String(album.id ?? ''));
    return found ? queue(catalogue.albumTracks(found.id), { kind: 'Album', name: found.title }) : null;
  }
  const artist = arg('artist');
  if (artist) {
    const name = String(artist.name ?? '');
    return queue(catalogue.artistTracks(name), { kind: 'Artist', name });
  }
  const playlist = arg('playlist');
  if (playlist) {
    const found = findPlaylist(catalogue, String(playlist.id ?? ''));
    return found ? queue(catalogue.playlistTracks(found.id), { kind: 'Playlist', name: found.name }) : null;
  }
  const folder = arg('folder');
  if (folder) {
    const dir = resolveFolderId(roots, String(folder.id ?? ''));
    if (!dir) return null;
    const tracks = catalogue
      .resolveSelectionPaths(roots, { folder: dir })
      .map((p) => catalogue.getTrack(p))
      .filter((t): t is Track => t !== null);
    return queue(tracks, { kind: 'Folder', name: path.basename(dir) });
  }
  const label = arg('label');
  if (label) {
    const name = String(label.name ?? '');
    return queue(catalogue.tracksForLabel(name), { kind: 'Label', name });
  }
  return null;
}
