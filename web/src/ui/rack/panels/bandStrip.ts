import { escapeHtml } from '../../../core/html';
import type { RackParam } from '../../../api/types';
import { onDrag } from '../drag';
import { EQ_MAX_HZ, EQ_MIN_HZ, freqToX, numberIn, xToFreq } from '../eqResponse';
import { isOn, offValue, onValue } from '../paramGroups';
import { spectrumPathsHtml, spectrumTogglesHtml } from '../spectrumDraw';
import { bandName, type PanelContext, type Section, type SectionRenderer } from './panelSpec';
import { bindKnobs, bindRows, knobsHtml, rowsHtml } from './sections';

/** ViewBox for the spectrum SVG behind the multiband strip. */
const MB_SPEC_W = 600;
const MB_SPEC_H = 220;

type BandSection = Extract<Section, { kind: 'bandTabs' }>;

const BAND_HUES = [
  'rgba(250, 197, 57, 0.55)',
  'rgba(120, 190, 170, 0.50)',
  'rgba(120, 160, 220, 0.50)',
  'rgba(220, 140, 100, 0.50)',
  'rgba(180, 140, 210, 0.48)',
  'rgba(100, 190, 140, 0.48)',
  'rgba(230, 170, 80, 0.50)',
  'rgba(140, 180, 210, 0.48)',
];

const GRID_HZ = [100, 1000, 10000];
/** Envelope / level meters typically sit around −60…0 dBFS. */
const METER_FLOOR = -60;
/** Gain reduction shown as 0…24 dB cut from the top of the band. */
const GR_CEILING = 24;

interface BandInfo {
  n: number;
  enable?: RackParam;
  on: boolean;
  compress: boolean;
  solo: boolean;
  mute: boolean;
  fromHz: number;
  toHz: number;
  threshold?: RackParam;
  ratio?: RackParam;
  split?: RackParam;
  soloParam?: RackParam;
  muteParam?: RackParam;
  envelope?: RackParam;
  reduction?: RackParam;
}

function hzLabel(hz: number): string {
  if (!Number.isFinite(hz) || hz <= 0) return '—';
  if (hz >= 1000) {
    const k = hz / 1000;
    return `${k >= 10 ? k.toFixed(0) : k.toFixed(1).replace(/\.0$/, '')}k`;
  }
  return String(Math.round(hz));
}

function rangeLabel(from: number, to: number): string {
  return `${hzLabel(from)}–${hzLabel(to)}`;
}

function paramHz(param: RackParam | undefined, fallback: number): number {
  if (!param) return fallback;
  const fromText = numberIn(param.text);
  if (Number.isFinite(fromText) && fromText > 0) return fromText;
  if (param.max > 20 && param.value >= param.min) return param.value;
  return fallback;
}

function ratioText(param: RackParam | undefined): string {
  if (!param) return '';
  const n = numberIn(param.text);
  if (Number.isFinite(n) && n > 0) return `${n % 1 === 0 ? n.toFixed(0) : n.toFixed(1)}:1`;
  return param.text.replace(/\s*ratio\s*/i, '') || '';
}

function hzText(hz: number): string {
  return hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 1 : 2)} kHz` : `${Math.round(hz)} Hz`;
}

function dbOf(param: RackParam | undefined, fallback = Number.NaN): number {
  if (!param) return fallback;
  const fromText = numberIn(param.text);
  if (Number.isFinite(fromText)) return fromText;
  return Number.isFinite(param.value) ? param.value : fallback;
}

/** Threshold as a line height 0…100% inside the band (−60…0 dB). */
function thresholdPct(param: RackParam | undefined): number {
  const thr = dbOf(param);
  if (!Number.isFinite(thr)) return 40;
  return Math.max(4, Math.min(96, ((thr - METER_FLOOR) / -METER_FLOOR) * 100));
}

function envelopePct(db: number): number {
  if (!Number.isFinite(db) || db <= METER_FLOOR) return 0;
  return Math.max(0, Math.min(100, ((db - METER_FLOOR) / -METER_FLOOR) * 100));
}

/** Reduction meters are usually negative dB (e.g. −6); also accept positive amount. */
function reductionPct(db: number): number {
  if (!Number.isFinite(db) || db === 0) return 0;
  const cut = Math.abs(db);
  return Math.max(0, Math.min(100, (cut / GR_CEILING) * 100));
}

function bandsOf(s: BandSection, ctx: PanelContext): BandInfo[] {
  const indices = Array.from({ length: s.count }, (_, i) => s.first + i);
  const raw = indices.map((n) => {
    const enable = s.enable ? ctx.param(bandName(s.enable, n)) : undefined;
    const on = s.alwaysOn?.includes(n) || !enable || isOn(enable);
    const compressParam = ctx.param(bandName('Compressor enable #', n));
    const split = ctx.param(bandName('Split frequency #', n));
    const soloParam = s.solo ? ctx.param(bandName(s.solo, n)) : undefined;
    const muteParam = s.mute ? ctx.param(bandName(s.mute, n)) : undefined;
    return {
      n,
      enable,
      on,
      compress: !compressParam || isOn(compressParam),
      solo: soloParam ? isOn(soloParam) : false,
      mute: muteParam ? isOn(muteParam) : false,
      fromHz: paramHz(split, n === s.first ? EQ_MIN_HZ : Number.NaN),
      split,
      soloParam,
      muteParam,
      threshold: ctx.param(bandName('Attack threshold #', n)),
      ratio: ctx.param(bandName('Ratio #', n)),
      envelope: s.envelope ? ctx.param(bandName(s.envelope, n)) : undefined,
      reduction: s.reduction ? ctx.param(bandName(s.reduction, n)) : undefined,
    };
  });

  const inPlay = raw.filter((b) => b.on);
  for (let i = 0; i < inPlay.length; i++) {
    const b = inPlay[i]!;
    if (!Number.isFinite(b.fromHz) || b.fromHz <= 0) {
      b.fromHz = i === 0 ? EQ_MIN_HZ : inPlay[i - 1]!.fromHz * 1.5;
    }
  }
  for (let i = 1; i < inPlay.length; i++) {
    if (inPlay[i]!.fromHz <= inPlay[i - 1]!.fromHz) {
      inPlay[i]!.fromHz = Math.min(EQ_MAX_HZ * 0.95, inPlay[i - 1]!.fromHz * 1.4);
    }
  }

  return inPlay.map((b, i) => ({
    ...b,
    toHz: i + 1 < inPlay.length ? inPlay[i + 1]!.fromHz : EQ_MAX_HZ,
  }));
}

function gridHtml(): string {
  return GRID_HZ.map((f) => {
    const x = (freqToX(f) * 100).toFixed(2);
    const label = f >= 1000 ? `${f / 1000}k` : String(f);
    return `
      <span class="mb-grid" style="left:${x}%"></span>
      <span class="mb-grid-label" style="left:${x}%">${label}</span>`;
  }).join('');
}

function bandHtml(b: BandInfo, chosen: number, index: number): string {
  const left = freqToX(Math.max(EQ_MIN_HZ, b.fromHz)) * 100;
  const right = freqToX(Math.min(EQ_MAX_HZ, b.toHz)) * 100;
  const width = Math.max(2, right - left);
  const hue = BAND_HUES[index % BAND_HUES.length]!;
  const selected = b.n === chosen;
  const thr = thresholdPct(b.threshold);
  const classes = [
    'mb-band',
    selected ? 'is-chosen' : '',
    b.compress ? '' : 'is-soft',
    b.solo ? 'is-solo' : '',
    b.mute ? 'is-mute' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const soloBtn = b.soloParam
    ? `<button type="button" class="mb-chip ${b.solo ? 'is-on' : ''}" data-solo="${b.n}" aria-pressed="${b.solo}" title="Solo band ${b.n}">S</button>`
    : '';
  const muteBtn = b.muteParam
    ? `<button type="button" class="mb-chip ${b.mute ? 'is-on mute' : ''}" data-mute="${b.n}" aria-pressed="${b.mute}" title="Mute band ${b.n}">M</button>`
    : '';

  return `
    <div class="${classes}" data-band="${b.n}" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%;--mb-hue:${hue}"
      role="button" tabindex="0" aria-pressed="${selected}" aria-label="Band ${b.n}, ${rangeLabel(b.fromHz, b.toHz)}">
      <span class="mb-env" data-env style="height:0%"></span>
      <span class="mb-gr" data-gr style="height:0%"></span>
      <span class="mb-thr" data-thr style="bottom:${thr.toFixed(0)}%"></span>
      <span class="mb-band-meta">
        <span class="mb-band-num">${b.n}</span>
        <span class="mb-band-range" data-range>${escapeHtml(rangeLabel(b.fromHz, b.toHz))}</span>
        <span class="mb-band-ratio" data-ratio>${escapeHtml(ratioText(b.ratio))}</span>
      </span>
      <span class="mb-band-chips">${soloBtn}${muteBtn}</span>
    </div>`;
}

function splitHandleHtml(b: BandInfo, index: number): string {
  if (index === 0 || !b.split) return '';
  const x = freqToX(Math.max(EQ_MIN_HZ, Math.min(EQ_MAX_HZ, b.fromHz))) * 100;
  return `<span class="mb-split" data-split-band="${b.n}" style="left:${x.toFixed(2)}%"
    role="slider" tabindex="0" aria-label="Split before band ${b.n}"></span>`;
}

function paintStripGeometry(root: HTMLElement, play: BandInfo[]): void {
  const anySolo = play.some((b) => b.solo);
  play.forEach((b, i) => {
    const el = root.querySelector<HTMLElement>(`[data-band="${b.n}"]`);
    if (el) {
      const left = freqToX(Math.max(EQ_MIN_HZ, b.fromHz)) * 100;
      const right = freqToX(Math.min(EQ_MAX_HZ, b.toHz)) * 100;
      el.style.left = `${left.toFixed(2)}%`;
      el.style.width = `${Math.max(2, right - left).toFixed(2)}%`;
      el.querySelector('[data-range]')!.textContent = rangeLabel(b.fromHz, b.toHz);
      el.classList.toggle('is-dimmed', anySolo && !b.solo);
      el.classList.toggle('is-solo', b.solo);
      el.classList.toggle('is-mute', b.mute);
      el.classList.toggle('is-soft', !b.compress);
    }
    if (i === 0) return;
    const handle = root.querySelector<HTMLElement>(`[data-split-band="${b.n}"]`);
    if (handle) handle.style.left = `${(freqToX(b.fromHz) * 100).toFixed(2)}%`;
  });
}

function paintThreshold(root: HTMLElement, n: number, param: RackParam | undefined): void {
  const el = root.querySelector<HTMLElement>(`[data-band="${n}"] [data-thr]`);
  if (el) el.style.bottom = `${thresholdPct(param).toFixed(0)}%`;
}

function paintRatio(root: HTMLElement, n: number, param: RackParam | undefined): void {
  const el = root.querySelector(`[data-band="${n}"] [data-ratio]`);
  if (el) el.textContent = ratioText(param);
}

function paintLiveMeters(
  root: HTMLElement,
  play: BandInfo[],
  byId: Record<string, { value: number; text: string }>
): void {
  for (const b of play) {
    const band = root.querySelector<HTMLElement>(`[data-band="${b.n}"]`);
    if (!band) continue;
    if (b.envelope) {
      const live = byId[b.envelope.id];
      const db = live ? numberIn(live.text) || live.value : dbOf(b.envelope, METER_FLOOR);
      const env = band.querySelector<HTMLElement>('[data-env]');
      if (env) env.style.height = `${envelopePct(db).toFixed(0)}%`;
    }
    if (b.reduction) {
      const live = byId[b.reduction.id];
      const db = live ? numberIn(live.text) || live.value : dbOf(b.reduction, 0);
      const gr = band.querySelector<HTMLElement>('[data-gr]');
      if (gr) gr.style.height = `${reductionPct(db).toFixed(0)}%`;
    }
  }
}

/**
 * Multiband compressor: tall frequency strip with live envelope / GR meters, Solo / Mute,
 * drag-to-split, and knobs for the chosen band.
 */
export function bandTabsSection(): SectionRenderer<BandSection> {
  let chosen: number | null = null;

  const forBand = (entries: Array<[string, string]>, n: number): Array<string | [string, string]> =>
    entries.map(([name, label]) => [bandName(name, n), label]);

  return {
    html: (s, ctx) => {
      const all = Array.from({ length: s.count }, (_, i) => s.first + i).map((n) => {
        const enable = s.enable ? ctx.param(bandName(s.enable, n)) : undefined;
        const on = s.alwaysOn?.includes(n) || !enable || isOn(enable);
        return { n, enable, on };
      });
      const play = bandsOf(s, ctx);
      if (chosen === null || !play.some((b) => b.n === chosen)) chosen = play[0]?.n ?? s.first;
      const next = all.find((b) => !b.on && b.enable);
      const n = chosen;
      const current = play.find((b) => b.n === n);
      const anySolo = play.some((b) => b.solo);

      const bandsMarkup = play
        .map((b, i) => {
          let html = bandHtml(b, n, i);
          if (anySolo && !b.solo) html = html.replace('class="mb-band', 'class="mb-band is-dimmed');
          return html;
        })
        .join('');

      const strip = `
        <div class="mb-stage" data-mb-stage>
          ${spectrumTogglesHtml()}
          <div class="mb-strip tall" data-mb-strip>
            <svg class="mb-spectrum" viewBox="0 0 ${MB_SPEC_W} ${MB_SPEC_H}" preserveAspectRatio="none" aria-hidden="true">
              ${spectrumPathsHtml()}
            </svg>
            <div class="mb-axis" aria-hidden="true">${gridHtml()}</div>
            <div class="mb-bands tall">
              ${bandsMarkup}
              ${play.map((b, i) => splitHandleHtml(b, i)).join('')}
            </div>
            <div class="mb-legend">
              <span>20</span>
              <span class="mb-legend-hint">S solo · M mute · drag split</span>
              <span>20k</span>
            </div>
          </div>
        </div>`;

      const add = next
        ? `<button type="button" class="deck-pill compact mb-add" data-band-add="${next.n}" aria-label="Add band ${next.n}">+</button>`
        : '';

      const soft =
        current && !current.compress
          ? `<p class="mb-soft-note">Band ${n}: compression off — enable <span class="mb-em">Compress</span> below.</p>`
          : '';

      return `
        ${strip}
        <div class="mb-toolbar">
          <p class="mb-chosen">Band ${n}<span class="mb-chosen-range">${escapeHtml(
            rangeLabel(current?.fromHz ?? 0, current?.toHz ?? EQ_MAX_HZ)
          )}</span></p>
          ${add}
        </div>
        ${soft}
        ${knobsHtml(present(forBand(s.knobs, n), ctx))}
        <div class="panel-rows compact">${rowsHtml(present(forBand(s.rows ?? [], n), ctx))}</div>`;
    },
    bind: (root, s, ctx) => {
      const n = chosen ?? s.first;
      const play = bandsOf(s, ctx);
      bindKnobs(root, present(forBand(s.knobs, n), ctx), ctx);
      bindRows(root, present(forBand(s.rows ?? [], n), ctx), ctx);

      const selectBand = (band: number) => {
        chosen = band;
        ctx.redraw();
      };

      root.querySelectorAll<HTMLElement>('[data-band]').forEach((tab) => {
        const go = () => selectBand(Number(tab.dataset.band));
        tab.addEventListener('click', (e) => {
          if ((e.target as HTMLElement).closest('[data-solo], [data-mute]')) return;
          go();
        });
        tab.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            go();
          }
        });
      });

      root.querySelector<HTMLElement>('[data-band-add]')?.addEventListener('click', (e) => {
        const band = Number((e.currentTarget as HTMLElement).dataset.bandAdd);
        const enable = s.enable ? ctx.param(bandName(s.enable, band)) : undefined;
        if (!enable) return;
        chosen = band;
        ctx.watch(enable.id, () => ctx.redraw());
        ctx.io(enable).set(onValue(enable));
      });

      const toggle = (param: RackParam | undefined, currentlyOn: boolean) => {
        if (!param) return;
        ctx.io(param).set(currentlyOn ? offValue(param) : onValue(param));
      };

      for (const b of play) {
        if (b.soloParam) ctx.watch(b.soloParam.id, () => ctx.redraw());
        if (b.muteParam) ctx.watch(b.muteParam.id, () => ctx.redraw());
      }

      root.querySelectorAll<HTMLElement>('[data-solo]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const band = play.find((x) => x.n === Number(btn.dataset.solo));
          toggle(band?.soloParam, !!band?.solo);
        });
      });
      root.querySelectorAll<HTMLElement>('[data-mute]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const band = play.find((x) => x.n === Number(btn.dataset.mute));
          toggle(band?.muteParam, !!band?.mute);
        });
      });

      // Live strip updates when knobs / compress change — no full redraw while dragging.
      for (const b of play) {
        if (b.threshold) {
          ctx.watch(b.threshold.id, (answer) => {
            const merged = { ...b.threshold!, ...answer };
            paintThreshold(root, b.n, merged);
          });
        }
        if (b.ratio) {
          ctx.watch(b.ratio.id, (answer) => {
            paintRatio(root, b.n, { ...b.ratio!, ...answer });
          });
        }
        const compress = ctx.param(bandName('Compressor enable #', b.n));
        if (compress) {
          ctx.watch(compress.id, (answer) => {
            root.querySelector(`[data-band="${b.n}"]`)?.classList.toggle('is-soft', !isOn({ ...compress, ...answer }));
          });
        }
      }

      const meterIds = play.flatMap((b) => [b.envelope?.id, b.reduction?.id].filter(Boolean) as string[]);
      const stage = root.querySelector<HTMLElement>('[data-mb-stage]');
      const strip = root.querySelector<HTMLElement>('[data-mb-strip]');
      if (stage) ctx.startSpectrum(stage, MB_SPEC_W, MB_SPEC_H);
      if (strip && meterIds.length) {
        ctx.pollParams(strip, meterIds, (byId) => paintLiveMeters(root, play, byId));
      }

      root.querySelectorAll<HTMLElement>('[data-split-band]').forEach((handle) => {
        const bandN = Number(handle.dataset.splitBand);
        const band = play.find((b) => b.n === bandN);
        if (!band?.split) return;
        const stripEl = root.querySelector<HTMLElement>('[data-mb-strip]');
        const lo = play.find((b) => b.n === bandN - 1)?.fromHz ?? EQ_MIN_HZ;
        const hi = play.find((b) => b.n === bandN + 1)?.fromHz ?? EQ_MAX_HZ;
        let live = band.fromHz;

        const applyGeometry = (hz: number) => {
          live = hz;
          const next = play.map((b) => ({ ...b }));
          const idx = next.findIndex((b) => b.n === bandN);
          if (idx >= 0) next[idx]!.fromHz = hz;
          for (let i = 0; i < next.length; i++) {
            next[i]!.toHz = i + 1 < next.length ? next[i + 1]!.fromHz : EQ_MAX_HZ;
          }
          paintStripGeometry(root, next);
          const title = root.querySelector('.mb-chosen-range');
          const chosenBand = next.find((b) => b.n === chosen);
          if (title && chosenBand) title.textContent = rangeLabel(chosenBand.fromHz, chosenBand.toHz);
        };

        const fromPointer = (clientX: number) => {
          if (!stripEl) return;
          const box = stripEl.getBoundingClientRect();
          const x = (clientX - box.left) / Math.max(1, box.width);
          const hz = Math.min(hi * 0.92, Math.max(lo * 1.08, xToFreq(x)));
          applyGeometry(hz);
          ctx.io(band.split!).setText(hzText(hz));
        };

        onDrag(handle, {
          start: (e) => {
            e.preventDefault();
            e.stopPropagation();
            fromPointer(e.clientX);
          },
          move: (e) => fromPointer(e.clientX),
          end: () => ctx.redraw(),
        });

        handle.addEventListener('keydown', (e) => {
          const step = e.key === 'ArrowLeft' ? 0.96 : e.key === 'ArrowRight' ? 1.04 : 0;
          if (!step) return;
          e.preventDefault();
          const nextHz = Math.min(hi * 0.92, Math.max(lo * 1.08, live * step));
          applyGeometry(nextHz);
          ctx.io(band.split!).setText(hzText(nextHz));
          ctx.redraw();
        });
        handle.addEventListener('click', (e) => e.stopPropagation());
      });
    },
  };
}

function present(
  entries: Array<string | [string, string]>,
  ctx: PanelContext
): Array<[RackParam, string]> {
  return entries
    .map((entry) => (typeof entry === 'string' ? ([entry, entry] as const) : entry))
    .map(([name, label]): [RackParam | undefined, string] => [ctx.param(name), label])
    .filter((pair): pair is [RackParam, string] => pair[0] !== undefined);
}
