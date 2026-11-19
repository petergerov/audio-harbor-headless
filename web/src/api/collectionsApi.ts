import type { HttpClient } from './http';
import type {
  CollectionTracks,
  LabelSummary,
  PlaylistChoice,
  PlaylistExport,
  PlaylistSummary,
  Selection,
} from './types';

export interface CollectionsApi {
  playlists(): Promise<PlaylistSummary[]>;
  labels(): Promise<LabelSummary[]>;
  playlistTracks(id: string): Promise<CollectionTracks>;
  labelTracks(name: string): Promise<CollectionTracks>;
  createPlaylist(name: string): Promise<{ id: string; name: string }>;
  renamePlaylist(id: string, name: string): Promise<void>;
  deletePlaylist(id: string): Promise<void>;
  addToPlaylist(id: string, selection: Selection): Promise<void>;
  removeFromPlaylist(id: string, cataloguePath: string): Promise<void>;
  addLabel(name: string, selection: Selection): Promise<void>;
  removeLabel(name: string, selection: Selection): Promise<void>;
  renameLabel(name: string, next: string): Promise<void>;
  deleteLabel(name: string): Promise<void>;
  /** The labels on one track. */
  trackLabels(cataloguePath: string): Promise<string[]>;
  /** The playlists, each marked if it holds every one of `paths`. */
  playlistChoices(paths: string[]): Promise<PlaylistChoice[]>;
  /** Appends the songs in order, skipping ones the playlist holds; returns how many went in. */
  addPaths(id: string, paths: string[]): Promise<number>;
  removePaths(id: string, paths: string[]): Promise<void>;
  /** The playlists as listed, in their new order. */
  reorderPlaylists(ids: string[]): Promise<void>;
  /** A playlist's songs as listed, in their new order. */
  reorderPlaylistTracks(id: string, paths: string[]): Promise<void>;
  /** Every playlist as an M3U8 file into `folder` on the host. */
  exportPlaylists(folder: string): Promise<PlaylistExport>;
}

/** The selection as request body: what it names, without the display title. */
function target(selection: Selection): Omit<Selection, 'title'> {
  return {
    cataloguePath: selection.cataloguePath,
    albumId: selection.albumId,
    artist: selection.artist,
    folder: selection.folder,
  };
}

const playlistPath = (id: string) => `/api/v1/playlists/${encodeURIComponent(id)}`;
const labelPath = (name: string) => `/api/v1/labels/${encodeURIComponent(name)}`;

export class HttpCollectionsApi implements CollectionsApi {
  constructor(private readonly http: HttpClient) {}

  async playlists(): Promise<PlaylistSummary[]> {
    return (await this.http.get<{ playlists: PlaylistSummary[] }>('/api/v1/playlists')).playlists;
  }

  async labels(): Promise<LabelSummary[]> {
    return (await this.http.get<{ labels: LabelSummary[] }>('/api/v1/labels')).labels;
  }

  playlistTracks(id: string): Promise<CollectionTracks> {
    return this.http.get(`${playlistPath(id)}/tracks`);
  }

  labelTracks(name: string): Promise<CollectionTracks> {
    return this.http.get(`${labelPath(name)}/tracks`);
  }

  createPlaylist(name: string): Promise<{ id: string; name: string }> {
    return this.http.post('/api/v1/playlists', { name });
  }

  async renamePlaylist(id: string, name: string): Promise<void> {
    await this.http.patch(playlistPath(id), { name });
  }

  async deletePlaylist(id: string): Promise<void> {
    await this.http.delete(playlistPath(id));
  }

  async addToPlaylist(id: string, selection: Selection): Promise<void> {
    await this.http.post(`${playlistPath(id)}/items`, target(selection));
  }

  async removeFromPlaylist(id: string, cataloguePath: string): Promise<void> {
    await this.http.delete(`${playlistPath(id)}/items`, { cataloguePath });
  }

  async addLabel(name: string, selection: Selection): Promise<void> {
    await this.http.post('/api/v1/labels/items', { name, ...target(selection) });
  }

  async removeLabel(name: string, selection: Selection): Promise<void> {
    // POST: some stacks drop DELETE bodies.
    await this.http.post('/api/v1/labels/remove-items', { name, ...target(selection) });
  }

  async renameLabel(name: string, next: string): Promise<void> {
    await this.http.patch(labelPath(name), { name: next });
  }

  async deleteLabel(name: string): Promise<void> {
    await this.http.delete(labelPath(name));
  }

  async playlistChoices(paths: string[]): Promise<PlaylistChoice[]> {
    return (await this.http.post<{ playlists: PlaylistChoice[] }>('/api/v1/playlists/choices', { paths })).playlists;
  }

  async addPaths(id: string, paths: string[]): Promise<number> {
    return (await this.http.post<{ added: number }>(`${playlistPath(id)}/items`, { paths })).added;
  }

  async removePaths(id: string, paths: string[]): Promise<void> {
    await this.http.delete(`${playlistPath(id)}/items`, { paths });
  }

  async reorderPlaylists(ids: string[]): Promise<void> {
    await this.http.put('/api/v1/playlists/order', { ids });
  }

  async reorderPlaylistTracks(id: string, paths: string[]): Promise<void> {
    await this.http.put(`${playlistPath(id)}/order`, { paths });
  }

  exportPlaylists(folder: string): Promise<PlaylistExport> {
    return this.http.post('/api/v1/playlists/export', { folder });
  }

  async trackLabels(cataloguePath: string): Promise<string[]> {
    const options = await this.http.get<{ trackLabels?: string[] }>(
      `/api/v1/track-options?path=${encodeURIComponent(cataloguePath)}`
    );
    return options.trackLabels ?? [];
  }
}
