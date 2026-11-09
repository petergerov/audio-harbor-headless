import type { CollectionKind, LibraryScope } from '../api/types';
import type { Store } from '../core/store';
import type { AlbumRef, AppState, CollectionsState, OpenCollection, SettingsPane, Tab } from '../state/appState';
import { applyRoute, isAbove, libraryDepth, parentRoute, routeKey, routeOf, type Route } from '../state/route';
import { withoutDrill } from '../state/selectors';
import type { CollectionsService } from './collectionsService';
import type { LibraryService } from './libraryService';

/** How the next screen comes in: deeper / another tab, one level up, or in place. */
export type Transition = 'forward' | 'back' | 'none';

/** Where the screens can go. */
export interface Navigation {
  goTo(tab: Tab): Promise<void>;
  openCollection(kind: CollectionKind, id: string, title: string): Promise<void>;
  openPlaylist(id: string, name: string): Promise<void>;
  closeCollection(): void;
  setLibraryScope(scope: LibraryScope): Promise<void>;
  /** One level up from the album, artist, folder or label open. */
  back(): Promise<void>;
  /** Whether there is a level to go up to. */
  canGoBack(): boolean;
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

/** The browser's history and scroll, as the navigator needs them. */
export interface HistoryPort {
  /** The route a reload left in the current entry, if any. */
  restored(): Route | null;
  /** A new entry for `route`; the entry left keeps `leavingScroll`. */
  push(route: Route, leavingScroll: number): void;
  replace(route: Route): void;
  back(): void;
  /** The route of the entry before the current one, when this page made it. */
  previous(): Route | null;
  /** Back / forward landed on `route`, last seen at `scroll`. */
  onPop(listener: (route: Route, scroll: number) => void): void;
  scrollY(): number;
  scrollTo(y: number, smooth?: boolean): void;
}

/** The open collection becomes `open`: its tracks stay when it is the same one, else they load. */
function withOpen(collections: CollectionsState, open: OpenCollection | null): CollectionsState {
  const same = collections.open && open && collections.open.kind === open.kind && collections.open.id === open.id;
  if (same || !open) return { ...collections, open, error: null };
  return { ...collections, open, items: [], loading: true, error: null };
}

/**
 * Moves through the app: updates the state, records it in history, renders the destination at once
 * (from memory or with placeholders) and fills it when the host answers.
 */
export class Navigator implements Navigation {
  /** Where each tab was left, so coming back to the same place keeps the scroll. */
  private readonly tabScroll = new Map<Tab, { key: string; y: number }>();

  constructor(
    private readonly store: Store<AppState>,
    private readonly library: LibraryService,
    private readonly collections: CollectionsService,
    private readonly history: HistoryPort,
    private readonly render: (transition: Transition) => void
  ) {
    history.onPop((route, scroll) => void this.arrive(route, scroll));
  }

  /** Back to where a reload left off, and the first history entry. */
  restore(): void {
    const route = this.history.restored();
    if (route) this.store.update((state) => this.toRoute(state, route));
    this.history.replace(routeOf(this.store.get()));
  }

  async goTo(tab: Tab): Promise<void> {
    const state = this.store.get();
    // Playlists / labels are not a primary tab (iOS: Deck · Catalogue · Settings).
    // A bare "collections" destination opens Catalogue → Lists instead.
    if (tab === 'collections' && !state.collections.open) {
      await this.move(
        (s) => ({
          tab: 'library',
          collections: withOpen(s.collections, null),
          library: { ...withoutDrill(s.library), scope: 'playlists', query: '' },
        }),
        'push',
        'forward'
      );
      return;
    }
    // The tab on screen tapped again: back to its top level, or to the top of the list.
    if (tab === state.tab) {
      if (tab === 'library' && (libraryDepth(routeOf(state)) > 0 || state.library.query)) {
        await this.move((s) => ({ library: { ...withoutDrill(s.library), query: '' } }), 'push', 'back');
      } else {
        this.history.scrollTo(0, true);
      }
      return;
    }
    // Another tab: it comes back where it was left (album, folder, search).
    if (tab === 'library') void this.collections.refresh();
    await this.move((s) => ({ tab, collections: withOpen(s.collections, null) }), 'push', 'forward');
  }

  async openCollection(kind: CollectionKind, id: string, title: string): Promise<void> {
    // Playlists stay in Catalogue → Lists; labels still use the collections drill view.
    if (kind === 'playlist') {
      await this.openPlaylist(id, title);
      return;
    }
    void this.collections.refresh();
    await this.move(
      (s) => ({ tab: 'collections', collections: withOpen(s.collections, { kind, id, title }) }),
      'push',
      'forward'
    );
  }

  async openPlaylist(id: string, name: string): Promise<void> {
    await this.move(
      (s) => ({
        tab: 'library',
        collections: withOpen(s.collections, null),
        library: { ...withoutDrill(s.library), scope: 'playlists', playlist: { id, name }, query: '' },
      }),
      'push',
      'forward'
    );
  }

  closeCollection(): void {
    void this.back();
  }

  async setLibraryScope(scope: LibraryScope): Promise<void> {
    // A segmented control: the entry changes, no new one.
    await this.move((s) => ({ library: { ...withoutDrill(s.library), scope, query: '' } }), 'replace', 'none');
  }

  canGoBack(): boolean {
    return parentRoute(routeOf(this.store.get())) !== null;
  }

  async back(): Promise<void> {
    const route = routeOf(this.store.get());
    const parent = parentRoute(route);
    if (!parent) return;
    // Came down from there: step back through history (its scroll comes back with it).
    const previous = this.history.previous();
    if (previous && isAbove(previous, route)) {
      this.history.back();
      return;
    }
    await this.move((s) => this.toRoute(s, parent), 'replace', 'back');
  }

  async openAlbum(album: AlbumRef, inScope?: LibraryScope): Promise<void> {
    await this.drill((s) => ({ library: { ...s.library, album, scope: inScope ?? s.library.scope, query: '' } }));
  }

  async openArtist(name: string): Promise<void> {
    await this.drill((s) => ({ library: { ...s.library, artist: name, query: '' } }));
  }

  async openFolder(path: string): Promise<void> {
    await this.drill((s) => {
      const library = s.library;
      return {
        library: {
          ...library,
          folderStack: library.folderPath ? [...library.folderStack, library.folderPath] : library.folderStack,
          folderPath: path,
          query: '',
        },
      };
    });
  }

  async search(query: string): Promise<void> {
    this.store.update((state) => ({ library: { ...withoutDrill(state.library), query } }));
    // The query belongs to this entry: back from a hit returns to the hits.
    this.history.replace(routeOf(this.store.get()));
    this.library.prime({ keepOnMiss: true });
    await this.library.load().catch(() => undefined);
  }

  setSettingsPane(pane: SettingsPane): void {
    this.store.update({ settingsPane: pane });
    this.history.replace(routeOf(this.store.get()));
    this.render('none');
  }

  openNowPlaying(): void {
    void this.goTo('now');
  }

  async refresh(): Promise<void> {
    await this.collections.refresh();
    const state = this.store.get();
    if (state.tab === 'library') await this.library.load().catch(() => undefined);
    if (state.tab === 'collections' && state.collections.open) await this.collections.loadOpen().catch(() => undefined);
    // A rename or delete may have moved the open label.
    this.history.replace(routeOf(this.store.get()));
    const y = this.history.scrollY();
    this.render('none');
    this.history.scrollTo(y);
  }

  /** One level deeper in the catalogue: a new entry, the top of the new list. */
  private drill(change: (state: AppState) => Partial<AppState>): Promise<void> {
    return this.move(change, 'push', 'forward');
  }

  /**
   * Changes the state, records it (a new entry or this one), and shows it. The scroll goes to the
   * top, or back to where a tab was left when it returns to the same place.
   */
  private async move(
    change: (state: AppState) => Partial<AppState>,
    how: 'push' | 'replace',
    transition: Transition
  ): Promise<void> {
    const before = this.store.get();
    const leavingScroll = this.history.scrollY();
    this.tabScroll.set(before.tab, { key: routeKey(routeOf(before)), y: leavingScroll });
    this.store.update(change);
    const after = this.store.get();
    const route = routeOf(after);
    if (how === 'push') this.history.push(route, leavingScroll);
    else this.history.replace(route);
    const memo = after.tab !== before.tab ? this.tabScroll.get(after.tab) : undefined;
    await this.show(transition, memo && memo.key === routeKey(route) ? memo.y : 0);
  }

  /** Back / forward: the route of the entry, at its scroll. */
  private async arrive(route: Route, scroll: number): Promise<void> {
    this.store.update((state) => this.toRoute(state, route));
    await this.show('back', scroll);
  }

  /**
   * Renders the state's screen at once — items from memory, or placeholders — then fills it.
   * The scroll lands once the list is tall enough for it.
   */
  private async show(transition: Transition, scroll: number): Promise<void> {
    const state = this.store.get();
    const key = routeKey(routeOf(state));
    let ready = true;
    if (state.tab === 'library') ready = this.library.prime();
    if (state.tab === 'collections') ready = !state.collections.loading;
    this.render(transition);
    this.history.scrollTo(ready ? scroll : 0);
    try {
      if (state.tab === 'library') await this.library.load();
      else if (state.tab === 'collections') await this.collections.loadOpen();
    } catch {
      return; // The screen says why.
    }
    if (!ready && scroll && routeKey(routeOf(this.store.get())) === key) this.history.scrollTo(scroll);
  }

  private toRoute(state: AppState, route: Route): Partial<AppState> {
    return { ...applyRoute(state, route), collections: withOpen(state.collections, route.open) };
  }
}
