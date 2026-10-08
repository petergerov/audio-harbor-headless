import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import type { EngineDevice, EngineState, OutputMode } from '@harbor/engine';
import type { OutputDevice, OutputStatus } from '../types.js';

const require = createRequire(import.meta.url);

type NativeEngine = {
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
  setEventListener?: (cb: (event: string, payload: string) => void) => void;
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
  dsdLevel: 0 | 3 | 6
): void {
  const eng = loadNative();
  if (!eng) return;
  eng.setDevice(deviceUid ?? null);
  eng.setOutputMode(mode);
  eng.setDsdPcmLevel(dsdLevel);
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

export function buildOutputStatus(
  selectedUid: string | null,
  requestedMode: OutputMode,
  networkDevices: OutputDevice[] = []
): OutputStatus {
  const local = listLocalDevices();
  const devices = [...local, ...networkDevices];
  const st = engineGetState();
  return {
    devices,
    selectedUid,
    requestedMode,
    effectiveMode: (st?.effectiveMode as OutputMode) ?? requestedMode,
    volume: st?.volume ?? null,
    conversionBadge: st?.conversionBadge ?? null,
  };
}
