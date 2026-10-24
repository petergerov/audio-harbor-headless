import type {
  BrowseItem,
  CollectionKind,
  LabelSummary,
  LibraryScope,
  NowPlaying,
  PlaylistSummary,
  QueueSnapshot,
  RackSnapshot,
  ScanProgress,
  SettingsSnapshot,
} from '../api/types';

export type Tab = 'library' | 'collections' | 'now' | 'settings';
export type SettingsPane = 'sources' | 'output' | 'rack' | 'sharing' | 'about';

export interface AlbumRef {
  id: string;
  title: string;
  artist: string;
}

export interface LibraryState {
  scope: LibraryScope;
  /** Folder drilled into (folders scope); the stack holds the ones above it. */
  folderPath: string | null;
  folderStack: string[];
  /** Album drilled into (albums scope). */
  album: AlbumRef | null;
  /** Artist drilled into (artists scope). */
  artist: string | null;
  /** Playlist drilled into (playlists / Lists scope). */
  playlist: { id: string; name: string } | null;
  query: string;
  items: BrowseItem[];
}

export interface OpenCollection {
  kind: CollectionKind;
  /** Playlist id, or the label's name. */
  id: string;
  title: string;
}

export interface CollectionsState {
  playlists: PlaylistSummary[];
  labels: LabelSummary[];
  open: OpenCollection | null;
  items: BrowseItem[];
}

export interface AppState {
  tab: Tab;
  library: LibraryState;
  collections: CollectionsState;
  settingsPane: SettingsPane;
  nowPlaying: NowPlaying | null;
  queue: QueueSnapshot | null;
  /** The host's Settings snapshot, as it pushes changes. */
  settings: SettingsSnapshot | null;
  /** The library scan, as the host pushes it. */
  scan: ScanProgress | null;
  /** The plugin rack, as the host pushes it. */
  rack: RackSnapshot | null;
}

export const initialState: AppState = {
  // `#settings` deep link (the macOS menu bar app opens Settings this way).
  tab: typeof location !== 'undefined' && location.hash === '#settings' ? 'settings' : 'now',
  library: {
    scope: 'folders',
    folderPath: null,
    folderStack: [],
    album: null,
    artist: null,
    playlist: null,
    query: '',
    items: [],
  },
  collections: { playlists: [], labels: [], open: null, items: [] },
  settingsPane: 'sources',
  nowPlaying: null,
  queue: null,
  settings: null,
  scan: null,
  rack: null,
};
