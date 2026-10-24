import type { EngineState } from '@harbor/engine';

/** How the engine's badge ends when it plays DSD as PCM. */
const DSD_TO_PCM = ' · DSD→PCM';

/** 44100 → "44.1 kHz", 96000 → "96 kHz"; `unit` false → "44.1". */
export function kHz(rate: number, unit = true): string {
  const value = String(Number((rate / 1000).toFixed(1)));
  return unit ? `${value} kHz` : value;
}

/** 2.8224 MHz → DSD64, twice that → DSD128 … */
export function dsdName(rate: number | null): string {
  return rate ? `DSD${Math.round(rate / 44_100)}` : 'DSD';
}

/** "44.1 kHz / 24-bit"; without a bit depth (lossy files) "44.1 kHz". */
export function resolution(sampleRate: number | null, bits: number | null): string {
  const rate = sampleRate ? kHz(sampleRate) : '';
  return [rate, bits ? `${bits}-bit` : ''].filter(Boolean).join(' / ');
}

/** " · FX" while plugins shape the sound, " · FX bypassed" while the rack only passes it on. */
export function rackSuffix(st: EngineState): string {
  const fx = st.fx;
  if (!fx?.applied) return '';
  return fx.processing && !fx.bypassed ? ' · FX' : ' · FX bypassed';
}

/**
 * What the DAC gets, then the engine's path — like a network player's badge, so a narrow
 * badge cuts the path, not the resolution: "96 kHz / 24-bit · Exclusive", "44.1 → 48 kHz /
 * 24-bit · Shared" when the system resamples, "DSD→PCM 88.2 kHz / 24-bit · Exclusive",
 * "DoP DSD64". Before a track is loaded, or where the platform does not tell the device
 * format (Windows), the badge as the engine has it.
 */
export function localPathLabel(st: EngineState): string | null {
  const label = deviceLabel(st);
  return label === null ? null : label + rackSuffix(st);
}

function deviceLabel(st: EngineState): string | null {
  const badge = st.conversionBadge;
  if (!st.streamRate || !st.deviceRate) return badge;
  if (st.dop) return `DoP ${dsdName(st.streamRate * 16)}`;
  const rate =
    st.deviceRate === st.streamRate ? kHz(st.deviceRate) : `${kHz(st.streamRate, false)} → ${kHz(st.deviceRate)}`;
  const res = st.deviceBits ? `${rate} / ${st.deviceBits}-bit` : rate;
  // "Exclusive · DSD→PCM" → DSD→PCM goes with the resolution, Exclusive is the path.
  const dsd = badge?.endsWith(DSD_TO_PCM) ?? false;
  const path =
    (dsd ? badge!.slice(0, -DSD_TO_PCM.length) : badge) ?? (st.effectiveMode === 'exclusive' ? 'Exclusive' : 'Shared');
  return `${dsd ? 'DSD→PCM ' : ''}${res} · ${path}`;
}
