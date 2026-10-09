export type OutputMode = 'shared' | 'exclusive' | 'dop';
export type AudioBackend = 'auto' | 'juce' | 'native';

export interface AudioBackendInfo {
  requested: AudioBackend | string;
  effective: AudioBackend | string;
  /** Comma-separated, e.g. "auto,juce,native" */
  available: string;
}

export interface EngineDevice {
  uid: string;
  name: string;
  isExternal: boolean;
  supportsExclusive: boolean;
  supportsDop: boolean;
}

export interface EngineState {
  state: 'idle' | 'loading' | 'playing' | 'paused' | 'failed';
  positionSecs: number;
  durationSecs: number | null;
  effectiveMode: OutputMode;
  conversionBadge: string | null;
  volume: number | null;
  error: string | null;
}

/** PCM for a network player: random access by frame, little-endian, interleaved. */
export interface NetStreamInfo {
  /** Opaque; pass to netStreamRead / netStreamClose. */
  handle: unknown;
  sampleRate: number;
  channels: number;
  frameCount: number;
  bitsPerSample: 16 | 24;
}

export interface NetStreamOptions {
  /** DSD only: 44.1 kHz / 16-bit instead of ~88.2 kHz / 24-bit. */
  wifi?: boolean;
  /** Gain on DSD converted to PCM. */
  dsdLevel?: 0 | 3 | 6;
}

export interface HarborEngine {
  version(): string;
  listDevices(): EngineDevice[];
  setDevice(uid: string | null): void;
  setOutputMode(mode: OutputMode): void;
  setDsdPcmLevel(db: 0 | 3 | 6): void;
  setAudioBackend(backend: AudioBackend): void;
  getAudioBackend(): AudioBackendInfo;
  load(path: string): Promise<void>;
  play(): void;
  pause(): void;
  stop(): void;
  seek(seconds: number): void;
  setVolume(level: number): void;
  getState(): EngineState;
  setEventListener(cb: (event: string, payload: string) => void): void;
  /** MPEG-4 DST session (opaque). Pair with dstDecodeFrame / dstEnd. */
  dstBegin(sampleRateHz: number, channels: number): unknown;
  dstDecodeFrame(session: unknown, frame: Buffer): Buffer;
  dstEnd(session: unknown): void;
  /** DSF / DFF → PCM; other formats decoded at their own rate. Opens on the libuv pool. */
  netStreamOpen(path: string, options?: NetStreamOptions): Promise<NetStreamInfo>;
  /** Packed frames [startFrame, startFrame + frameCount); shorter at the end. */
  netStreamRead(handle: unknown, startFrame: number, frameCount: number): Promise<Buffer>;
  netStreamClose(handle: unknown): void;
}

declare const engine: HarborEngine;
export default engine;
