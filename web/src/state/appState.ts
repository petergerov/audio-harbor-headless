import type {
  BrowseItem,
  CollectionKind,
  LabelSummary,
  LibraryScope,
  NowPlaying,
  PlaylistSummary,
  QueueSnapshot,
  SettingsSnapshot,
} from '../api/types';

export type Tab = 'library' | 'collections' | 'now' | 'settings';
export type SettingsPane = 'sources' | 'output' | 'sharing' | 'about';

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
}

export const initialState: AppState = {
  tab: 'library',
  library: {
    scope: 'albums',
    folderPath: null,
    folderStack: [],
    album: null,
    artist: null,
    query: '',
    items: [],
  },
  collections: { playlists: [], labels: [], open: null, items: [] },
  settingsPane: 'sources',
  nowPlaying: null,
  queue: null,
  settings: null,
};
