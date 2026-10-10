import type { Track } from '../api/types';
import type { AppState, LibraryState } from './appState';

export function currentTrack(state: AppState): Track | null {
  return state.nowPlaying?.track ?? null;
}

export function isPlaying(state: AppState): boolean {
  return state.nowPlaying?.state === 'playing';
}

export function nowPlayingPath(state: AppState): string | null {
  return currentTrack(state)?.cataloguePath ?? null;
}

/** `path` is loaded and playing, paused or loading — a tap on it then pauses or resumes. */
export function isCurrentTrack(state: AppState, path: string): boolean {
  const np = state.nowPlaying;
  return np?.track?.cataloguePath === path && (np.state === 'playing' || np.state === 'paused' || np.state === 'loading');
}

/** Why playback stopped (e.g. the network player left), while it is in the failed state. */
export function playbackError(state: AppState): string {
  const np = state.nowPlaying;
  return np?.state === 'failed' && np.error ? np.error : '';
}

export function durationSecs(state: AppState): number {
  return Number(state.nowPlaying?.durationSecs ?? 0) || 0;
}

/** What the library browses into: folder path, album id, artist name or playlist id. */
export function drillPath(library: LibraryState): string | null {
  if (library.scope === 'folders') return library.folderPath;
  if (library.scope === 'albums') return library.album?.id ?? null;
  if (library.scope === 'artists') return library.artist;
  if (library.scope === 'playlists') return library.playlist?.id ?? null;
  return null;
}

/** Back to the scope's top level. */
export function withoutDrill(library: LibraryState): LibraryState {
  return {
    ...library,
    folderPath: null,
    folderStack: [],
    album: null,
    artist: null,
    playlist: null,
  };
}

/** Which player chrome the layout shows around the screen. */
export interface Chrome {
  wide: boolean;
  /** Phone: mini player above the tab bar — not on the Deck screen. */
  mini: boolean;
  /** Phone: compact player in the page header of Library and Playlists (off for now). */
  header: boolean;
  /** Desktop: bottom bar when a track is loaded — not on the Deck screen. */
  bar: boolean;
}

export function chromeFor(state: AppState, desktop: boolean): Chrome {
  const loaded = currentTrack(state) !== null;
  const onDeck = state.tab === 'now';
  return {
    wide: desktop,
    mini: loaded && !desktop && !onDeck,
    // Compact header player: not needed for now. HeaderPlayer stays wired up; restore the line
    // below to bring it back.
    // header: loaded && !desktop && (state.tab === 'library' || state.tab === 'collections'),
    header: false,
    bar: loaded && desktop && !onDeck,
  };
}
