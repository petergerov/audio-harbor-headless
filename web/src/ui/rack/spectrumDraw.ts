import type { InsertMeter } from '../../api/types';
import type { RackApi } from '../../api/rackApi';
import { EQ_MAX_HZ, EQ_MIN_HZ, freqToX } from './eqResponse';

/** Spectrum floor / ceiling for the filled overlay (independent of the EQ ±dB scale). */
export const SPECTRUM_FLOOR_DB = -90;
export const SPECTRUM_CEIL_DB = 0;

const POLL_MS = 90;
const TOGGLE_KEY = 'harbor.spec.toggles';

export interface SpectrumBins {
  in: number[];
  out: number[];
}

export interface SpecToggles {
  in: boolean;
  out: boolean;
}

/** Filled path under a live spectrum: log frequency across, dB up from the floor. */
export function spectrumAreaPath(
  bins: number[],
  width: number,
  height: number,
  floorDb = SPECTRUM_FLOOR_DB,
  ceilDb = SPECTRUM_CEIL_DB
): string {
  if (!bins.length) return '';
  const yOf = (db: number) => {
    const t = (Math.max(floorDb, Math.min(ceilDb, db)) - floorDb) / (ceilDb - floorDb);
    return height * (1 - t);
  };
  const n = bins.length;
  const parts: string[] = [`M0 ${height.toFixed(1)}`];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    const hz = EQ_MIN_HZ * Math.pow(EQ_MAX_HZ / EQ_MIN_HZ, t);
    const x = freqToX(hz) * width;
    parts.push(`L${x.toFixed(1)} ${yOf(bins[i] ?? floorDb).toFixed(1)}`);
  }
  parts.push(`L${width.toFixed(1)} ${height.toFixed(1)} Z`);
  return parts.join(' ');
}

function readToggles(): SpecToggles {
  try {
    const raw = sessionStorage.getItem(TOGGLE_KEY);
    if (raw) {
      const j = JSON.parse(raw) as Partial<SpecToggles>;
      return { in: j.in !== false, out: j.out !== false };
    }
  } catch {
    // ignore
  }
  return { in: true, out: true };
}

function writeToggles(t: SpecToggles): void {
  try {
    sessionStorage.setItem(TOGGLE_KEY, JSON.stringify(t));
  } catch {
    // ignore
  }
}

/** In / Out chips above a spectrum stage. */
export function spectrumTogglesHtml(): string {
  const t = readToggles();
  return `
    <div class="spec-toggles" data-spec-toggles>
      <button type="button" class="spec-chip ${t.in ? 'is-on' : ''}" data-spec-toggle="in" aria-pressed="${t.in}">In</button>
      <button type="button" class="spec-chip out ${t.out ? 'is-on' : ''}" data-spec-toggle="out" aria-pressed="${t.out}">Out</button>
    </div>`;
}

/** Two spectrum paths for an SVG of `width`×`height`. */
export function spectrumPathsHtml(): string {
  return `
    <path class="eq-spectrum is-in" data-spec-in d="" />
    <path class="eq-spectrum is-out" data-spec-out d="" />`;
}

/**
 * Wires In/Out toggles and paints both spectra into `[data-spec-in]` / `[data-spec-out]`
 * under `root` while it stays on screen.
 */
export function bindSpectrumOverlay(
  root: HTMLElement,
  rack: RackApi,
  insertId: string,
  width: number,
  height: number
): void {
  let toggles = readToggles();
  const inPath = root.querySelector<SVGPathElement>('[data-spec-in]');
  const outPath = root.querySelector<SVGPathElement>('[data-spec-out]');
  const host = root.querySelector<HTMLElement>('[data-spec-toggles]') ?? root;

  const applyVisibility = () => {
    inPath?.classList.toggle('is-hidden', !toggles.in);
    outPath?.classList.toggle('is-hidden', !toggles.out);
    root.querySelectorAll<HTMLElement>('[data-spec-toggle]').forEach((btn) => {
      const which = btn.dataset.specToggle as 'in' | 'out';
      const on = toggles[which];
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-pressed', String(on));
    });
  };

  root.querySelectorAll<HTMLElement>('[data-spec-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const which = btn.dataset.specToggle as 'in' | 'out';
      toggles = { ...toggles, [which]: !toggles[which] };
      // Keep at least one visible so the stage never goes blank by accident.
      if (!toggles.in && !toggles.out) toggles[which] = true;
      writeToggles(toggles);
      applyVisibility();
    });
  });
  applyVisibility();

  const tick = async () => {
    if (!host.isConnected) return;
    try {
      const meter: InsertMeter | undefined = (await rack.meters())[insertId];
      const binsIn = meter?.spectrumIn ?? meter?.spectrum ?? [];
      const binsOut = meter?.spectrumOut ?? [];
      if (inPath && toggles.in) inPath.setAttribute('d', spectrumAreaPath(binsIn, width, height));
      if (outPath && toggles.out) outPath.setAttribute('d', spectrumAreaPath(binsOut, width, height));
    } catch {
      // A missed reading is not worth a message.
    }
    if (host.isConnected) window.setTimeout(() => void tick(), POLL_MS);
  };
  window.setTimeout(() => void tick(), 0);
}

/** @deprecated Use bindSpectrumOverlay. */
export function runSpectrum(
  el: HTMLElement,
  rack: RackApi,
  insertId: string,
  update: (bins: number[]) => void
): void {
  const tick = async () => {
    if (!el.isConnected) return;
    try {
      const meter: InsertMeter | undefined = (await rack.meters())[insertId];
      update(meter?.spectrumIn ?? meter?.spectrum ?? []);
    } catch {
      // ignore
    }
    if (el.isConnected) window.setTimeout(() => void tick(), POLL_MS);
  };
  window.setTimeout(() => void tick(), 0);
}
