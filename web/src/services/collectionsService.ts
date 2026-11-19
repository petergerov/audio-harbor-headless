import type { CollectionsApi } from '../api/collectionsApi';
import type { CollectionKind, PlaylistChoice, PlaylistExport, Selection } from '../api/types';
import type { Store } from '../core/store';
import { errorMessage } from '../core/errors';
import type { AppState, CollectionsState } from '../state/appState';

/** Playlists and labels: the lists, the open one, and changes to them. */
export class CollectionsService {
  constructor(
    private readonly api: CollectionsApi,
    private readonly store: Store<AppState>
  ) {}

  /** Fresh playlist and label lists; the old ones stay when the host cannot be reached. */
  async refresh(): Promise<void> {
    try {
      const [playlists, labels] = await Promise.all([this.api.playlists(), this.api.labels()]);
      this.patch({ playlists, labels });
    } catch {
      /* keep what we have */
    }
  }

  /** The tracks of the open playlist or label, and its current name. */
  async loadOpen(): Promise<void> {
    const open = this.store.get().collections.open;
    if (!open) {
      this.patch({ items: [], loading: false, error: null });
      return;
    }
    const still = () => {
      const now = this.store.get().collections.open;
      return now?.kind === open.kind && now.id === open.id;
    };
    try {
      const { name, tracks } =
        open.kind === 'playlist' ? await this.api.playlistTracks(open.id) : await this.api.labelTracks(open.id);
      // Another one was opened meanwhile: its own load fills the screen.
      if (still()) this.patch({ open: { ...open, title: name }, items: tracks, loading: false, error: null });
    } catch (err) {
      if (still()) this.patch({ loading: false, error: errorMessage(err, 'Could not load it') });
      throw err;
    }
  }

  createPlaylist(name: string): Promise<{ id: string; name: string }> {
    return this.api.createPlaylist(name);
  }

  async rename(kind: CollectionKind, id: string, next: string): Promise<void> {
    if (kind === 'playlist') await this.api.renamePlaylist(id, next);
    else await this.api.renameLabel(id, next);
    const open = this.store.get().collections.open;
    if (open?.kind === kind && open.id === id) {
      // A label is named by its name: the open one moves with it.
      this.patch({ open: { kind, id: kind === 'label' ? next : id, title: next } });
    }
  }

  async remove(kind: CollectionKind, id: string): Promise<void> {
    if (kind === 'playlist') await this.api.deletePlaylist(id);
    else await this.api.deleteLabel(id);
    const open = this.store.get().collections.open;
    if (open?.kind === kind && open.id === id) this.patch({ open: null });
  }

  addToPlaylist(id: string, selection: Selection): Promise<void> {
    return this.api.addToPlaylist(id, selection);
  }

  removeFromPlaylist(id: string, cataloguePath: string): Promise<void> {
    return this.api.removeFromPlaylist(id, cataloguePath);
  }

  addLabel(name: string, selection: Selection): Promise<void> {
    return this.api.addLabel(name, selection);
  }

  removeLabel(name: string, selection: Selection): Promise<void> {
    return this.api.removeLabel(name, selection);
  }

  trackLabels(cataloguePath: string): Promise<string[]> {
    return this.api.trackLabels(cataloguePath);
  }

  playlistChoices(paths: string[]): Promise<PlaylistChoice[]> {
    return this.api.playlistChoices(paths);
  }

  addPaths(id: string, paths: string[]): Promise<number> {
    return this.api.addPaths(id, paths);
  }

  removePaths(id: string, paths: string[]): Promise<void> {
    return this.api.removePaths(id, paths);
  }

  /** The playlists in a new order: the lists show it at once, then the host's answer. */
  async reorderPlaylists(ids: string[]): Promise<void> {
    const rank = new Map(ids.map((id, i) => [id, i]));
    const playlists = this.store.get().collections.playlists;
    const slots = playlists.flatMap((p, i) => (rank.has(p.id) ? [i] : []));
    const moved = slots.map((i) => playlists[i]!).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
    const next = playlists.slice();
    slots.forEach((slot, i) => {
      next[slot] = moved[i]!;
    });
    this.patch({ playlists: next });
    try {
      await this.api.reorderPlaylists(ids);
    } finally {
      await this.refresh();
    }
  }

  /** A playlist's songs in a new order. */
  reorderPlaylistTracks(id: string, paths: string[]): Promise<void> {
    return this.api.reorderPlaylistTracks(id, paths);
  }

  exportPlaylists(folder: string): Promise<PlaylistExport> {
    return this.api.exportPlaylists(folder);
  }

  private patch(change: Partial<CollectionsState>): void {
    this.store.update((state) => ({ collections: { ...state.collections, ...change } }));
  }
}
