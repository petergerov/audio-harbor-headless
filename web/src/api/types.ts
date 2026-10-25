/** What the host's API sends and takes (host/src/types.ts, from the client's side). */

export type PlaybackState = 'idle' | 'loading' | 'playing' | 'paused' | 'failed';
export type RepeatMode = 'off' | 'all' | 'one';
export type LibraryScope = 'folders' | 'albums' | 'artists' | 'playlists';
export type CollectionKind = 'playlist' | 'label';
export type NetworkStream = 'full' | 'wifi';
/** How a network player gets DSD: the DSD file when it lists DSD (auto), PCM, or DoP. */
export type NetworkDsd = 'auto' | 'pcm' | 'dop';
export type TransportCommand = 'play' | 'pause' | 'toggle' | 'stop' | 'next' | 'previous';
/** Gain on DSD played as PCM, in dB. */
export type DsdPcmLevel = 0 | 3 | 6;
export type QueueSourceKind = 'Album' | 'Artist' | 'Folder' | 'Playlist' | 'Label' | 'Queue';

/** Where the queue came from ("Album", "Kind of Blue"). */
export interface QueueSource {
  kind: QueueSourceKind;
  name: string | null;
}

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
  dsdPcmLevel: DsdPcmLevel;
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
  /** Position in the queue as it plays; null when nothing is queued. */
  queueIndex: number | null;
  queueCount: number;
  queueSource: QueueSource;
}

/** The queue in play order (shuffled when shuffle is on). */
export interface QueueSnapshot {
  tracks: Track[];
  currentIndex: number | null;
  source: QueueSource;
}

export interface RemoteOutputDevice {
  uid: string;
  name: string;
  kind: 'local' | 'network';
  supportsExclusive: boolean;
  supportsDoP: boolean;
}

/** How a network player is fed, as the Mac's three choices. */
export type NetworkChoice = 'wifiFriendly' | 'full' | 'dsd';

/** The host's Settings, as the iOS app gets them too (Swift SettingsSnapshot). */
export interface SettingsSnapshot {
  output: {
    devices: RemoteOutputDevice[];
    /** null = system default output. */
    selectedUID: string | null;
    selectedName: string | null;
    isNetworkSelected: boolean;
    isDeviceMissing: boolean;
    outputMode: string;
    effectiveOutputMode: string;
    canExclusive: boolean;
    canDoP: boolean;
    networkChoice: NetworkChoice;
    supportsNativeDSD: boolean;
    dsdPCMLevel: DsdPcmLevel;
  };
  sharing: {
    enabled: boolean;
    statusText: string;
    blockedByLicense: boolean;
    activeStreams: number;
  };
  directories: Array<{ id: string; name: string; displayPath: string }>;
  isScanning: boolean;
  about: {
    appName: string;
    versionLabel: string;
    tagline: string;
    licenseHeadline: string;
    licenseDetail: string;
  };
}

/** One change to the host's Settings (Swift SettingsPatch). */
export type SettingsPatch =
  | { outputDevice: { uid: string | null } }
  | { outputMode: { value: string } }
  | { networkChoice: { value: NetworkChoice } }
  | { dsdPCMLevel: { value: DsdPcmLevel } }
  | { sharingEnabled: { value: boolean } }
  | { rebuildIndex: true };

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

/** CPU, memory and disk space of the host (GET /api/v1/system). */
export interface SystemStatus {
  hostname: string;
  platform: string;
  cpu: { model: string; cores: number; usagePercent: number; load1: number; temperatureC: number | null };
  memory: { totalBytes: number; availableBytes: number; harborBytes: number };
  disks: { mount: string; uses: string[]; totalBytes: number; freeBytes: number }[];
  uptimeSecs: number;
  harborUptimeSecs: number;
}

/** The latest release on GitHub; `state` is the update the host runs, or ran last since boot. */
export interface UpdateStatus {
  current: string;
  latest: string | null;
  tag: string | null;
  releaseUrl: string | null;
  available: boolean;
  /** The host installs it itself (Linux .deb, run as the service). */
  canInstall: boolean;
  /** Why not from here, or how to update instead. */
  note: string | null;
  checkedAt: number | null;
  checkError: string | null;
  state: 'idle' | 'starting' | 'downloading' | 'installing' | 'done' | 'failed';
  target: string | null;
  message: string | null;
}

/** Where the host's library scan is (pushed as `scan`); `lastScan` stays after it ends. */
export interface ScanProgress {
  scanning: boolean;
  phase: 'idle' | 'listing' | 'reading' | 'finishing';
  root: string | null;
  done: number;
  total: number;
  indexed: number;
  lastScan: { at: number; scanned: number; indexed: number } | null;
}

/** A drive the host sees; `name` is set once it has a Harbor fstab entry under /mnt/harbor. */
export interface Drive {
  kind: 'drive' | 'share';
  uuid: string;
  title: string;
  device: string | null;
  fsType: string;
  sizeBytes: number | null;
  connected: boolean;
  name: string | null;
  mountPoint: string | null;
  mounted: boolean;
  suggestedName: string;
}

export interface DriveList {
  supported: boolean;
  reason: string | null;
  drives: Drive[];
}

export interface FolderEntry {
  name: string;
  path: string;
}

/** `path` null: the places to start from (drives, /media, home). */
export interface FolderListing {
  path: string | null;
  parent: string | null;
  folders: FolderEntry[];
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
  dsdPcmLevel?: DsdPcmLevel;
}

/** A plugin installed on the host. */
export interface RackPlugin {
  format: 'clap' | 'lv2';
  path: string;
  id: string;
  name: string;
  vendor: string;
  version: string;
  features: string[];
  /** A stereo effect — what the rack takes. */
  stereo: boolean;
  /** Shipped with Audio Harbor and picked for a job ("Graphic EQ"). */
  role?: string;
}

/** One plugin parameter, in its own units, with its own text for the value. */
export interface RackParam {
  id: string;
  name: string;
  module?: string;
  min: number;
  max: number;
  default: number;
  value: number;
  text: string;
  stepped: boolean;
  isBypass?: boolean;
  /** Set by the plugin only (a meter). */
  readOnly?: boolean;
  /** A stepped parameter's values with the plugin's text for each. */
  options?: Array<{ value: number; text: string }>;
}

/** Peak level into and out of an insert, dBFS; out − in is what it does to the level. */
export interface InsertMeter {
  in: number;
  out: number;
}

/** A whole rack kept under a name. */
export interface RackPresetSummary {
  id: string;
  name: string;
  plugins: string[];
}

export interface RackInsert {
  id: string;
  /** CLAP id or LV2 URI — picks a panel for the plugins the remote knows. */
  pluginId: string;
  name: string;
  vendor: string;
  format: string;
  bypassed: boolean;
  loaded: boolean;
  error: string | null;
  /** Up to six parameters for the rack sheet. */
  pinned: RackParam[];
}

/** The host's plugin rack. */
export interface RackSnapshot {
  /** The host can run plugins. */
  available: boolean;
  /** Whole rack bypassed for A/B. */
  bypassed: boolean;
  inserts: RackInsert[];
  /** What leaves the rack; lit while plugins shape the sound. */
  path: { label: string; lit: boolean; note: string };
  latencyMs: number;
  error: string | null;
  presets: RackPresetSummary[];
  /** The preset the rack was loaded from; `edited` once it changed since. */
  activePreset: string | null;
  edited: boolean;
}
