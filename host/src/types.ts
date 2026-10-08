export type OutputMode = 'shared' | 'exclusive' | 'dop';
/** juce | native | auto — native = Core Audio / ALSA / WASAPI */
export type AudioBackend = 'auto' | 'juce' | 'native';
export type PlaybackState = 'idle' | 'loading' | 'playing' | 'paused' | 'failed';
export type RepeatMode = 'off' | 'all' | 'one';
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
  uid: string;
  name: string;
  kind: 'local' | 'network';
  supportsExclusive: boolean;
  supportsDop: boolean;
  isExternal: boolean;
}

export interface OutputStatus {
  devices: OutputDevice[];
  selectedUid: string | null;
  requestedMode: OutputMode;
  effectiveMode: OutputMode;
  volume: number | null;
  conversionBadge: string | null;
  audioBackend: AudioBackend;
  effectiveAudioBackend: string;
  availableAudioBackends: string[];
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
  };
  library: {
    roots: string[];
  };
  output: {
    device_uid?: string | null;
    mode: OutputMode;
    dsd_pcm_level: 0 | 3 | 6;
    /** auto = native on Mac/Linux, juce on Windows */
    backend: AudioBackend;
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
