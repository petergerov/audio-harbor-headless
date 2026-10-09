import type { CollectionsApi } from '../api/collectionsApi';
import type { CollectionKind, Selection } from '../api/types';
import type { Store } from '../core/store';
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
      this.patch({ items: [] });
      return;
    }
    const { name, tracks } =
      open.kind === 'playlist' ? await this.api.playlistTracks(open.id) : await this.api.labelTracks(open.id);
    this.patch({ open: { ...open, title: name }, items: tracks });
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

  private patch(change: Partial<CollectionsState>): void {
    this.store.update((state) => ({ collections: { ...state.collections, ...change } }));
  }
}
