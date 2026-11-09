import type { LibraryScope } from '../api/types';
import type { AlbumRef, AppState, OpenCollection, SettingsPane, Tab } from './appState';

/** Where the user is: what a history entry holds, and what back / forward bring back. */
export interface Route {
  tab: Tab;
  scope: LibraryScope;
  folderPath: string | null;
  folderStack: string[];
  album: AlbumRef | null;
  artist: string | null;
  playlist: { id: string; name: string } | null;
  query: string;
  /** The label (or playlist) open in the collections drill view. */
  open: OpenCollection | null;
  settingsPane: SettingsPane;
}

export function routeOf(state: AppState): Route {
  const { scope, folderPath, folderStack, album, artist, playlist, query } = state.library;
  return {
    tab: state.tab,
    scope,
    folderPath,
    folderStack,
    album,
    artist,
    playlist,
    query,
    open: state.collections.open,
    settingsPane: state.settingsPane,
  };
}

/** The state change that puts the screens at `route`; items load separately. */
export function applyRoute(state: AppState, route: Route): Partial<AppState> {
  return {
    tab: route.tab,
    settingsPane: route.settingsPane,
    library: {
      ...state.library,
      scope: route.scope,
      folderPath: route.folderPath,
      folderStack: [...route.folderStack],
      album: route.album,
      artist: route.artist,
      playlist: route.playlist,
      query: route.query,
    },
    collections: { ...state.collections, open: route.open },
  };
}

/** One string per place in the catalogue, for comparing two routes. */
export function routeKey(route: Route): string {
  return JSON.stringify([
    route.tab,
    route.scope,
    route.folderPath,
    route.folderStack,
    route.album?.id ?? null,
    route.artist,
    route.playlist?.id ?? null,
    route.query,
    route.open ? [route.open.kind, route.open.id] : null,
    route.tab === 'settings' ? route.settingsPane : null,
  ]);
}

/** How deep the catalogue is drilled: 0 at a scope's top level. */
export function libraryDepth(route: Route): number {
  if (route.scope === 'folders') return route.folderPath ? route.folderStack.length + 1 : 0;
  if (route.scope === 'albums') return route.album ? 1 : 0;
  if (route.scope === 'artists') return route.artist ? 1 : 0;
  return route.playlist ? 1 : 0;
}

/** One level up from an album, artist, folder, playlist or open label; null at a top level. */
export function parentRoute(route: Route): Route | null {
  if (route.tab === 'collections') return route.open ? { ...route, tab: 'library', open: null } : null;
  if (route.tab !== 'library' || libraryDepth(route) === 0) return null;
  const up = { ...route, query: '' };
  if (route.scope === 'folders') {
    const folderStack = [...route.folderStack];
    return { ...up, folderPath: folderStack.pop() ?? null, folderStack };
  }
  if (route.scope === 'albums') return { ...up, album: null };
  if (route.scope === 'artists') return { ...up, artist: null };
  return { ...up, playlist: null };
}

/**
 * Whether going back from `route` to `previous` (the history entry before it) is going up:
 * then the in-app back link steps back through history instead of adding an entry.
 */
export function isAbove(previous: Route, route: Route): boolean {
  if (route.tab === 'collections') return previous.tab === 'library' || (previous.tab === 'collections' && !previous.open);
  return route.tab === 'library' && previous.tab === 'library' && libraryDepth(previous) < libraryDepth(route);
}
