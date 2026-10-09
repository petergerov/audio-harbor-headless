import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import type {
  AudioBackendInfo,
  EngineDevice,
  EngineState,
  NetStreamInfo,
  NetStreamOptions,
  OutputMode,
} from '@harbor/engine';
import type { AudioBackend, OutputDevice, OutputStatus } from '../types.js';

const require = createRequire(import.meta.url);

type NativeEngine = {
  version(): string;
  listDevices(): EngineDevice[];
  setDevice(uid: string | null): void;
  setOutputMode(mode: OutputMode): void;
  setDsdPcmLevel(db: 0 | 3 | 6): void;
  setAudioBackend?(backend: AudioBackend): void;
  getAudioBackend?(): AudioBackendInfo;
  load(path: string): Promise<void>;
  play(): void;
  pause(): void;
  stop(): void;
  seek(seconds: number): void;
  setVolume(level: number): void;
  getState(): EngineState;
  setEventListener?: (cb: (event: string, payload: string) => void) => void;
  dstBegin?(sampleRateHz: number, channels: number): unknown;
  dstDecodeFrame?(session: unknown, frame: Buffer): Buffer;
  dstEnd?(session: unknown): void;
  netStreamOpen?(path: string, options?: NetStreamOptions): Promise<NetStreamInfo>;
  netStreamRead?(handle: unknown, startFrame: number, frameCount: number): Promise<Buffer>;
  netStreamClose?(handle: unknown): void;
};

let native: NativeEngine | null = null;
let loadError: string | null = null;

function loadNative(): NativeEngine | null {
  if (native) return native;
  try {
    const mod = require('@harbor/engine') as NativeEngine;
    native = mod;
    if (typeof mod.setEventListener === 'function') {
      mod.setEventListener((event, payload) => {
        engineEvents.emit(event, payload ? JSON.parse(payload) : {});
      });
    }
    return native;
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
    return null;
  }
}

export const engineEvents = new EventEmitter();

export function engineVersion(): string {
  const eng = loadNative();
  return eng?.version() ?? `unavailable: ${loadError ?? 'not built'}`;
}

export function listLocalDevices(): OutputDevice[] {
  const eng = loadNative();
  if (!eng) return [];
  return eng.listDevices().map((d) => ({
    uid: d.uid,
    name: d.name,
    kind: 'local' as const,
    supportsExclusive: d.supportsExclusive,
    supportsDop: d.supportsDop,
    isExternal: d.isExternal,
  }));
}

export function applyOutput(
  deviceUid: string | null | undefined,
  mode: OutputMode,
  dsdLevel: 0 | 3 | 6,
  backend: AudioBackend = 'auto'
): void {
  const eng = loadNative();
  if (!eng) return;
  if (typeof eng.setAudioBackend === 'function') eng.setAudioBackend(backend);
  eng.setDevice(deviceUid ?? null);
  eng.setOutputMode(mode);
  eng.setDsdPcmLevel(dsdLevel);
}

export function engineAudioBackend(): AudioBackendInfo | null {
  return loadNative()?.getAudioBackend?.() ?? null;
}

export async function engineLoad(path: string): Promise<void> {
  const eng = loadNative();
  if (!eng) throw new Error(loadError ?? 'Engine not available');
  await eng.load(path);
}

export function enginePlay(): void {
  loadNative()?.play();
}
export function enginePause(): void {
  loadNative()?.pause();
}
export function engineStop(): void {
  loadNative()?.stop();
}
export function engineSeek(seconds: number): void {
  loadNative()?.seek(seconds);
}
export function engineSetVolume(level: number): void {
  loadNative()?.setVolume(level);
}

export function engineGetState(): EngineState | null {
  return loadNative()?.getState() ?? null;
}

export function engineDstBegin(sampleRateHz: number, channels: number): unknown {
  const eng = loadNative();
  if (!eng?.dstBegin) throw new Error('DST decoder not available');
  return eng.dstBegin(sampleRateHz, channels);
}

export function engineDstDecodeFrame(session: unknown, frame: Buffer): Buffer {
  const eng = loadNative();
  if (!eng?.dstDecodeFrame) throw new Error('DST decoder not available');
  return eng.dstDecodeFrame(session, frame);
}

export function engineDstEnd(session: unknown): void {
  loadNative()?.dstEnd?.(session);
}

/** PCM for a network player (DSD converted, other formats decoded), read by frame. */
export async function engineNetStreamOpen(path: string, options: NetStreamOptions): Promise<NetStreamInfo> {
  const eng = loadNative();
  if (!eng?.netStreamOpen) throw new Error(loadError ?? 'Engine cannot stream to network players');
  return eng.netStreamOpen(path, options);
}

export async function engineNetStreamRead(
  handle: unknown,
  startFrame: number,
  frameCount: number
): Promise<Buffer> {
  const eng = loadNative();
  if (!eng?.netStreamRead) throw new Error('Engine cannot stream to network players');
  return eng.netStreamRead(handle, startFrame, frameCount);
}

export function engineNetStreamClose(handle: unknown): void {
  loadNative()?.netStreamClose?.(handle);
}

/** What the engine knows; the playback service adds the pick and the network side. */
export type EngineOutputStatus = Omit<
  OutputStatus,
  'selectedName' | 'selectedKind' | 'selectedAvailable' | 'networkStream' | 'networkDsd' | 'discoveryError'
>;

export function buildOutputStatus(
  selectedUid: string | null,
  requestedMode: OutputMode,
  networkDevices: OutputDevice[] = [],
  requestedBackend: AudioBackend = 'auto'
): EngineOutputStatus {
  const local = listLocalDevices();
  const devices = [...local, ...networkDevices];
  const st = engineGetState();
  const be = engineAudioBackend();
  return {
    devices,
    selectedUid,
    requestedMode,
    effectiveMode: (st?.effectiveMode as OutputMode) ?? requestedMode,
    volume: st?.volume ?? null,
    conversionBadge: st?.conversionBadge ?? null,
    audioBackend: requestedBackend,
    effectiveAudioBackend: String(be?.effective ?? requestedBackend),
    availableAudioBackends: String(be?.available ?? 'auto')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
