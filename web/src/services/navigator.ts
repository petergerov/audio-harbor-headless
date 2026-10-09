import type { CollectionKind, LibraryScope } from '../api/types';
import type { Store } from '../core/store';
import type { AlbumRef, AppState, LibraryState, SettingsPane, Tab } from '../state/appState';
import { withoutDrill } from '../state/selectors';
import type { CollectionsService } from './collectionsService';
import type { LibraryService } from './libraryService';

/** Where the screens can go. */
export interface Navigation {
  goTo(tab: Tab): Promise<void>;
  openCollection(kind: CollectionKind, id: string, title: string): Promise<void>;
  closeCollection(): void;
  setLibraryScope(scope: LibraryScope): Promise<void>;
  /** One level up from the album, artist or folder drilled into. */
  back(): Promise<void>;
  openAlbum(album: AlbumRef, inScope?: LibraryScope): Promise<void>;
  openArtist(name: string): Promise<void>;
  openFolder(path: string): Promise<void>;
  /** Filters the library; the caller repaints its list (the search field keeps focus). */
  search(query: string): Promise<void>;
  setSettingsPane(pane: SettingsPane): void;
  openNowPlaying(): void;
  /** Fresh playlists and labels, then the current screen again (after a change to them). */
  refresh(): Promise<void>;
}

/** Moves through the app: updates the state, loads what the destination shows, renders it. */
export class Navigator implements Navigation {
  constructor(
    private readonly store: Store<AppState>,
    private readonly library: LibraryService,
    private readonly collections: CollectionsService,
    private readonly render: () => void
  ) {}

  async goTo(tab: Tab): Promise<void> {
    this.store.update((state) => ({
      tab,
      collections: { ...state.collections, open: null },
      library: tab === 'library' ? withoutDrill(state.library) : state.library,
    }));
    if (tab === 'library') await this.library.load();
    if (tab === 'collections') await this.collections.refresh();
    this.render();
  }

  async openCollection(kind: CollectionKind, id: string, title: string): Promise<void> {
    this.store.update((state) => ({
      tab: 'collections',
      collections: { ...state.collections, open: { kind, id, title } },
    }));
    await this.collections.loadOpen();
    this.render();
  }

  closeCollection(): void {
    this.store.update((state) => ({ collections: { ...state.collections, open: null } }));
    this.render();
  }

  async setLibraryScope(scope: LibraryScope): Promise<void> {
    await this.browse((library) => ({ ...withoutDrill(library), scope }));
  }

  async back(): Promise<void> {
    await this.browse((library) => {
      if (library.scope === 'folders' && library.folderPath) {
        const folderStack = [...library.folderStack];
        return { ...library, folderPath: folderStack.pop() ?? null, folderStack };
      }
      if (library.scope === 'albums') return { ...library, album: null };
      if (library.scope === 'artists') return { ...library, artist: null };
      return library;
    });
  }

  async openAlbum(album: AlbumRef, inScope?: LibraryScope): Promise<void> {
    await this.browse((library) => ({ ...library, album, scope: inScope ?? library.scope }));
  }

  async openArtist(name: string): Promise<void> {
    await this.browse((library) => ({ ...library, artist: name }));
  }

  async openFolder(path: string): Promise<void> {
    await this.browse((library) => ({
      ...library,
      folderStack: library.folderPath ? [...library.folderStack, library.folderPath] : library.folderStack,
      folderPath: path,
    }));
  }

  async search(query: string): Promise<void> {
    this.store.update((state) => ({ library: { ...withoutDrill(state.library), query } }));
    await this.library.load();
  }

  setSettingsPane(pane: SettingsPane): void {
    this.store.update({ settingsPane: pane });
    this.render();
  }

  openNowPlaying(): void {
    this.store.update({ tab: 'now' });
    this.render();
  }

  async refresh(): Promise<void> {
    await this.collections.refresh();
    this.render();
  }

  /** A library move: the new level, an empty search, its items, a render. */
  private async browse(move: (library: LibraryState) => LibraryState): Promise<void> {
    this.store.update((state) => ({ library: { ...move(state.library), query: '' } }));
    await this.library.load();
    this.render();
  }
}
