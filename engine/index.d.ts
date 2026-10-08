export type OutputMode = 'shared' | 'exclusive' | 'dop';

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

export interface HarborEngine {
  version(): string;
  listDevices(): EngineDevice[];
  setDevice(uid: string | null): void;
  setOutputMode(mode: OutputMode): void;
  setDsdPcmLevel(db: 0 | 3 | 6): void;
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
}

declare const engine: HarborEngine;
export default engine;
