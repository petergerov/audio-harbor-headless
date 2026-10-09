export type OutputMode = 'shared' | 'exclusive' | 'dop';
/** juce | native | auto — native = Core Audio / ALSA / WASAPI */
export type AudioBackend = 'auto' | 'juce' | 'native';
export type PlaybackState = 'idle' | 'loading' | 'playing' | 'paused' | 'failed';
export type RepeatMode = 'off' | 'all' | 'one';
/** UPnP network players: full = best the player takes; wifi = DSD as 44.1 kHz / 16-bit PCM. */
export type NetworkStreamQuality = 'full' | 'wifi';
export type BrowseScope = 'folders' | 'albums' | 'artists' | 'playlists' | 'labels';

export type AudioFormat =
  | 'flac'
  | 'alac'
  | 'wav'
  | 'aiff'
  | 'aac'
  | 'mp3'
  | 'dsf'
  | 'dff'
  | 'sacd'
  | 'unknown';

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
  format: AudioFormat;
  artworkHash: string | null;
  labels: string[];
  fileSize: number | null;
}

export interface Album {
  id: string;
  title: string;
  artist: string;
  year: number | null;
  trackCount: number;
  artworkHash: string | null;
}

export interface Artist {
  name: string;
  albumCount: number;
  trackCount: number;
}

export interface FolderRoot {
  id: string;
  path: string;
  displayName: string;
}

export interface OutputDevice {
  /** Network players: `upnp:<UDN>`, so the pick survives power cycles. */
  uid: string;
  name: string;
  kind: 'local' | 'network';
  supportsExclusive: boolean;
  supportsDop: boolean;
  isExternal: boolean;
  manufacturer?: string;
  model?: string;
}

export interface OutputStatus {
  /** Local devices, then the network players on the LAN right now. */
  devices: OutputDevice[];
  selectedUid: string | null;
  /** Last known name of the pick — kept while a network player is off. */
  selectedName: string | null;
  selectedKind: 'local' | 'network' | null;
  /** The pick is plugged in / on the network now. */
  selectedAvailable: boolean;
  requestedMode: OutputMode;
  effectiveMode: OutputMode;
  volume: number | null;
  conversionBadge: string | null;
  audioBackend: AudioBackend;
  effectiveAudioBackend: string;
  availableAudioBackends: string[];
  networkStream: NetworkStreamQuality;
  /** Why no network players can be found (no network, no Local Network access). */
  discoveryError: string | null;
}

export interface NowPlayingSnapshot {
  state: PlaybackState;
  track: Track | null;
  positionSecs: number;
  durationSecs: number | null;
  shuffle: boolean;
  repeat: RepeatMode;
  volume: number | null;
  output: OutputStatus;
  conversionBadge: string | null;
  /** Why playback failed (state `failed`), e.g. the network player left. */
  error: string | null;
}

export interface QueueSnapshot {
  tracks: Track[];
  currentIndex: number | null;
}

export interface HarborConfig {
  server: {
    host: string;
    port: number;
    name: string;
    /** mDNS name: "audioharbor" → http://audioharbor.local:<port>; "" turns it off. */
    local_hostname: string;
  };
  library: {
    roots: string[];
  };
  output: {
    device_uid?: string | null;
    /** Name of the picked device, shown while it is unplugged / off the network. */
    device_name?: string | null;
    mode: OutputMode;
    dsd_pcm_level: 0 | 3 | 6;
    /** auto = native on Mac/Linux, juce on Windows */
    backend: AudioBackend;
    network_stream: NetworkStreamQuality;
  };
  network: {
    /** HTTP port network players pull audio from (any free port when taken). */
    media_port: number;
  };
  sharing: {
    enabled: boolean;
    port: number;
    friendly_name: string;
  };
  remote: {
    bonjour_enabled: boolean;
    bonjour_port: number;
  };
}
