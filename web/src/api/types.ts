/** What the host's API sends and takes (host/src/types.ts, from the client's side). */

export type PlaybackState = 'idle' | 'loading' | 'playing' | 'paused' | 'failed';
export type RepeatMode = 'off' | 'all' | 'one';
export type LibraryScope = 'albums' | 'artists' | 'folders';
export type CollectionKind = 'playlist' | 'label';
export type NetworkStream = 'full' | 'wifi';
/** How a network player gets DSD: the DSD file when it lists DSD (auto), PCM, or DoP. */
export type NetworkDsd = 'auto' | 'pcm' | 'dop';
export type TransportCommand = 'play' | 'pause' | 'toggle' | 'stop' | 'next' | 'previous';

export interface Track {
  id: string;
  cataloguePath: string;
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  trackNumber: number | null;
  discNumber: number | null;
  year: number | null;
  durationSecs: number | null;
  sampleRate: number | null;
  bitDepth: number | null;
  channels: number | null;
  format: string;
  artworkHash: string | null;
  labels: string[];
  fileSize: number | null;
}

export interface AlbumEntry {
  id: string;
  title: string;
  artist: string;
  year: number | null;
  trackCount: number;
  artworkHash: string | null;
}

export interface ArtistEntry {
  name: string;
  albumCount: number;
  trackCount: number;
}

export interface FolderEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  track: Track | null;
}

/** One row of a browse or search answer: an album, an artist, a folder entry or a track. */
export type BrowseItem = Partial<Track & AlbumEntry & ArtistEntry & FolderEntry>;

export interface OutputDevice {
  uid: string;
  name: string;
  kind: 'local' | 'network';
  isExternal: boolean;
  supportsExclusive: boolean;
  supportsDop: boolean;
}

export interface OutputStatus {
  devices: OutputDevice[];
  selectedUid: string | null;
  selectedName: string | null;
  selectedKind: 'local' | 'network' | null;
  selectedAvailable: boolean;
  requestedMode: string;
  effectiveMode: string;
  conversionBadge: string | null;
  networkStream: NetworkStream;
  /** DSD mode of the picked network player. */
  networkDsd: NetworkDsd;
  discoveryError: string | null;
}

/** What a network player lists (GetProtocolInfo), its volume and its stored DSD mode. */
export interface NetworkPlayerFormats {
  uid: string;
  online: boolean;
  /** It answered with a list of types. */
  listed: boolean;
  /** DSD types it lists (audio/x-dsf, audio/x-dff, …). */
  dsd: string[];
  /** What goes to it untouched in Auto: DSF, DFF (SACD too). */
  nativeDsd: Array<'dsf' | 'dff'>;
  /** 0…1; null when unknown. */
  volume: number | null;
  dsdMode: NetworkDsd;
}

export interface NowPlaying {
  state: PlaybackState;
  track: Track | null;
  positionSecs: number;
  durationSecs: number | null;
  shuffle: boolean;
  repeat: RepeatMode;
  volume: number | null;
  output: OutputStatus;
  conversionBadge: string | null;
  error: string | null;
}

export interface PlaylistSummary {
  id: string;
  name: string;
  trackCount: number;
}

export interface LabelSummary {
  name: string;
  trackCount: number;
}

export interface CollectionTracks {
  name: string;
  tracks: BrowseItem[];
}

export interface Mount {
  id: string;
  path: string;
  displayName: string;
}

/** What a play request queues: one of the contexts, optionally starting at a track. */
export interface PlayContext {
  cataloguePath?: string;
  albumId?: string;
  artist?: string;
  folder?: string;
  playlistId?: string;
  label?: string;
}

/** What an organize action (playlist, label) applies to: a track, album, artist or folder. */
export interface Selection {
  cataloguePath?: string;
  albumId?: string;
  artist?: string;
  folder?: string;
  /** For sheet titles; not sent. */
  title: string;
}

export interface OutputChange {
  deviceUid: string | null;
  mode: string;
  networkStream: NetworkStream;
  /** Stored for the picked network player. */
  networkDsd?: NetworkDsd;
}
