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
import type { LiveStatus } from '../api/liveUpdates';

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
  /** The items are on their way and none are known yet: the list shows placeholders. */
  loading: boolean;
  /** Why the items could not be loaded, while none show. */
  error: string | null;
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
  /** The open one's tracks are on their way. */
  loading: boolean;
  /** Why the open one's tracks could not be loaded. */
  error: string | null;
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
  /** Whether the host's push channel is up. */
  connection: LiveStatus;
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
    loading: false,
    error: null,
  },
  collections: { playlists: [], labels: [], open: null, items: [], loading: false, error: null },
  settingsPane: 'sources',
  nowPlaying: null,
  queue: null,
  settings: null,
  scan: null,
  rack: null,
  connection: 'connecting',
};
