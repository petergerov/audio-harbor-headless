export type OutputMode = 'shared' | 'exclusive' | 'dop';
export type AudioBackend = 'auto' | 'native';

export interface AudioBackendInfo {
  requested: AudioBackend | string;
  effective: AudioBackend | string;
  /** Comma-separated, e.g. "auto,native" */
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
  /** Rate the engine feeds the device (file, DSD→PCM or DoP carrier); 0 when nothing is loaded. */
  streamRate: number;
  /** Rate and bits the device runs at; 0 when the platform does not tell (Windows). */
  deviceRate: number;
  deviceBits: number;
  dop: boolean;
  volume: number | null;
  error: string | null;
  fx: EngineFxState;
}

/** The plugin rack as the engine runs it. */
export interface EngineFxState {
  /** This track plays through the rack (inserts loaded, PCM). */
  applied: boolean;
  /** Some insert is in circuit: the plugins shape the sound. */
  processing: boolean;
  /** Whole rack bypassed for A/B. */
  bypassed: boolean;
  /** Frames, compensated. */
  latency: number;
  /** harbor-fx is running. */
  running: boolean;
  /** Why the rack is not running, or null. */
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
  /** DSD only: the DSD bits untouched as DoP — 24-bit at DSD rate / 16 (DSD64 → 176.4 kHz). */
  dop?: boolean;
  /** PCM through the plugin rack, as 24-bit (not with DoP). */
  fx?: boolean;
}

/** A capture device (ALSA hw: on Linux). */
export interface RecordInput {
  id: string;
  name: string;
}

export interface RecordStartOptions {
  /** hw:CARD=…,DEV=…; or file:<wav> / filefast:<wav> to feed a WAV in as if it were live. */
  device: string;
  /** Must be the input's rate: nothing resamples, a wrong rate fails. */
  rate: number;
  channels?: number;
  /** The raw take: 32-bit WAV, left-justified, exactly as captured. */
  rawPath: string;
  /** Threshold for the live "silent" flag. */
  silenceDb?: number;
}

export interface RecordStatus {
  active: boolean;
  device: string;
  rate: number;
  channels: number;
  deviceBits: number;
  frames: number;
  seconds: number;
  /** Input buffer overruns / frames lost to a slow disk. Both 0: the take is bit-perfect. */
  overruns: number;
  dropped: number;
  /** Data came in during the last second. */
  signal: boolean;
  content: 'pcm' | 'dop' | 'bitstream';
  /** Bits the PCM used in the last second: 0 (digital silence), 16, 24 or 32. */
  bits: number;
  silent: boolean;
  /** Peak per channel since the last status, 0…1. */
  peaks: number[];
  error: string | null;
  /** The take stopped by itself (disk full). */
  failed: boolean;
}

export interface RecordFinalizeOptions {
  rawPath: string;
  outDir: string;
  split?: boolean;
  silenceDb?: number;
  silenceSeconds?: number;
  /** Vorbis comments for each FLAC (TITLE and TRACKNUMBER are added per file). */
  tags?: Record<string, string>;
  /** File and title stem: "<titleBase> 01.flac". */
  titleBase?: string;
}

export interface RecordedFile {
  path: string;
  kind: 'flac' | 'dsf' | 'spdif' | 'wav';
  sampleRate: number;
  bits: number;
  frames: number;
  seconds: number;
}

export interface RecordFinalizeResult {
  files: RecordedFile[];
  skippedFrames: number;
  totalFrames: number;
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
  /** One JSON request to harbor-fx (started on first use); resolves to its JSON reply. */
  fxRequest(json: string): Promise<string>;
  /** Whole-rack bypass for A/B, faded in ~10 ms. */
  fxSetBypass(bypassed: boolean): void;
  /** A parameter is moving: the rack renders with a short lead for the next seconds. */
  fxTouch(): void;
  /** harbor-fx path; null = next to harbor_engine.node (or $HARBOR_FX). */
  fxSetBinary(path: string | null): void;
  /** Capture devices (none outside Linux). */
  recordInputs(): RecordInput[];
  /** Throws when the input cannot run at exactly this rate. */
  recordStart(options: RecordStartOptions): void;
  /** Stops and closes the raw take; its final status. */
  recordStop(): RecordStatus;
  recordStatus(): RecordStatus;
  /** Raw take → FLAC / DSF / .spdif, on the libuv pool. */
  recordFinalize(options: RecordFinalizeOptions): Promise<RecordFinalizeResult>;
  /** 0…1 while finishing; null otherwise. */
  recordFinalizeProgress(): number | null;
}

declare const engine: HarborEngine;
export default engine;
