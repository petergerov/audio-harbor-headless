import type { RackParam } from '../../../api/types';
import {
  freqToX,
  logFrequencies,
  numberIn,
  qFromOctaves,
  response,
  shapeOf,
  xToFreq,
  type EqBand,
} from '../eqResponse';
import { onDrag } from '../drag';
import { isOn, onValue } from '../paramGroups';
import { bandName, type EqBandNames, type PanelContext, type Section, type SectionRenderer } from './panelSpec';
import { bindRows, rowsHtml } from './sections';

type EqSection = Extract<Section, { kind: 'eqCurve' }>;

const W = 600;
const H = 220;
/** The curve shows ±18 dB. */
const RANGE_DB = 18;
const POINTS = 160;
const GRID_HZ = [100, 1000, 10000];
const GRID_DB = [-12, -6, 0, 6, 12];
/** Shapes with a gain to drag up and down. */
const HAS_GAIN = new Set(['bell', 'lowshelf', 'highshelf']);
/** Where a new band starts, by how many are in play: spread across the range, not at 16 Hz. */
const NEW_BAND_HZ = [1000, 250, 4000, 100, 10000, 500, 2000, 60];

const yOf = (db: number) => H / 2 - (Math.max(-RANGE_DB, Math.min(RANGE_DB, db)) / RANGE_DB) * (H / 2);
const dbOf = (y: number) => ((H / 2 - y) / (H / 2)) * RANGE_DB;

interface Band {
  n: number;
  params: { type: RackParam; freq?: RackParam; gain?: RackParam; q?: RackParam; width?: RackParam; slope?: RackParam };
  model: EqBand;
}

function bandsOf(section: EqSection, ctx: PanelContext): Band[] {
  const names: EqBandNames = section.bands;
  const out: Band[] = [];
  for (let n = section.first; n < section.first + section.count; n++) {
    const get = (pattern?: string) => (pattern ? ctx.param(bandName(pattern, n)) : undefined);
    const type = get(names.type);
    if (!type) continue;
    const params = { type, freq: get(names.freq), gain: get(names.gain), q: get(names.q), width: get(names.width), slope: get(names.slope) };
    const q = params.q ? numberIn(params.q.text) : Number.NaN;
    out.push({
      n,
      params,
      model: {
        shape: isOn(type) ? shapeOf(type.text) : 'flat',
        freq: params.freq ? numberIn(params.freq.text) : 1000,
        gainDb: params.gain ? params.gain.value : 0,
        q: q > 0 ? q : params.width ? qFromOctaves(numberIn(params.width.text)) : Math.SQRT1_2,
        order: params.slope ? Math.max(1, numberIn(params.slope.text) || 1) : 1,
      },
    });
  }
  return out;
}

function curvePath(bands: Band[]): string {
  const freqs = logFrequencies(POINTS);
  const db = response(bands.map((b) => b.model), freqs);
  return freqs.map((f, i) => `${i ? 'L' : 'M'}${(freqToX(f) * W).toFixed(1)} ${yOf(db[i] ?? 0).toFixed(1)}`).join(' ');
}

function gridHtml(): string {
  const v = GRID_HZ.map((f) => `<line class="eq-grid" x1="${freqToX(f) * W}" x2="${freqToX(f) * W}" y1="0" y2="${H}" />`);
  const h = GRID_DB.map((d) => `<line class="eq-grid ${d === 0 ? 'zero' : ''}" x1="0" x2="${W}" y1="${yOf(d)}" y2="${yOf(d)}" />`);
  const labels = GRID_HZ.map((f) => `<text class="eq-label" x="${freqToX(f) * W + 4}" y="${H - 6}">${f >= 1000 ? `${f / 1000}k` : f}</text>`);
  return [...v, ...h, ...labels].join('');
}

/** Where a band's point sits: its frequency across, its gain up (centre for shapes without one). */
function pointAt(model: EqBand): string {
  const y = HAS_GAIN.has(model.shape) ? yOf(model.gainDb) : H / 2;
  return `translate(${(freqToX(model.freq) * W).toFixed(1)} ${y.toFixed(1)})`;
}

function pointHtml(band: Band, label: number, chosen: boolean): string {
  return `
    <g class="eq-point ${chosen ? 'is-chosen' : ''}" data-point="${band.n}" transform="${pointAt(band.model)}">
      <circle r="13" /><text text-anchor="middle" dy="4">${label}</text>
    </g>`;
}

/** The chosen band's controls below the curve. */
function bandRows(band: Band): Array<[RackParam, string]> {
  const { type, freq, gain, q, slope } = band.params;
  const rows: Array<[RackParam | undefined, string]> = [
    [type, 'Type'],
    [freq, 'Frequency'],
    [gain, 'Gain'],
    [q, 'Q'],
    [slope, 'Slope'],
  ];
  return rows.filter((r): r is [RackParam, string] => r[0] !== undefined);
}

/**
 * The equalizer as a curve: drag a band's point sideways for its frequency and up or down for
 * its gain; tap it for its type, Q and slope below. The curve follows at once; the plugin's
 * answers settle it.
 */
export function eqCurveSection(): SectionRenderer<EqSection> {
  let chosen: number | null = null;
  const label = (section: EqSection, n: number) => n - section.first + 1;

  return {
    html(section, ctx) {
      const bands = bandsOf(section, ctx);
      const inPlay = bands.filter((b) => isOn(b.params.type));
      if (chosen === null || !inPlay.some((b) => b.n === chosen)) chosen = inPlay[0]?.n ?? null;
      const band = inPlay.find((b) => b.n === chosen);
      const next = bands.find((b) => !isOn(b.params.type));
      return `
        <svg class="eq-curve" viewBox="0 0 ${W} ${H}" data-eq>
          ${gridHtml()}
          <path class="eq-line" data-eq-line d="${curvePath(bands)}" />
          ${inPlay.map((b) => pointHtml(b, label(section, b.n), b.n === chosen)).join('')}
        </svg>
        <div class="band-tabs">
          ${inPlay.map((b) => `<button type="button" class="deck-pill ${b.n === chosen ? 'is-on' : ''}" data-eq-band="${b.n}">${label(section, b.n)}</button>`).join('')}
          ${next ? `<button type="button" class="deck-pill" data-eq-add="${next.n}" aria-label="Add a band">+ Band</button>` : ''}
        </div>
        ${band ? `<div class="panel-rows">${rowsHtml(bandRows(band))}</div>` : '<p class="panel-note">No band in play — add one.</p>'}`;
    },

    bind(root, section, ctx) {
      const svg = root.querySelector<SVGSVGElement>('[data-eq]');
      const line = root.querySelector<SVGPathElement>('[data-eq-line]');
      const repaint = () => {
        if (line) line.setAttribute('d', curvePath(bandsOf(section, ctx)));
      };
      const bands = bandsOf(section, ctx);
      const band = bands.find((b) => b.n === chosen);
      if (band) {
        bindRows(root, bandRows(band), ctx);
        // A new type or slope changes the drawing, and which points can move up and down.
        ctx.watch(band.params.type.id, () => ctx.redraw());
      }
      for (const b of bands) {
        for (const p of Object.values(b.params)) if (p) ctx.watch(p.id, repaint);
      }

      root.querySelectorAll<HTMLElement>('[data-eq-band]').forEach((tab) =>
        tab.addEventListener('click', () => {
          chosen = Number(tab.dataset.eqBand);
          ctx.redraw();
        })
      );
      root.querySelector<HTMLElement>('[data-eq-add]')?.addEventListener('click', (e) => {
        const n = Number((e.currentTarget as HTMLElement).dataset.eqAdd);
        const type = ctx.param(bandName(section.bands.type, n));
        const freq = ctx.param(bandName(section.bands.freq, n));
        if (!type) return;
        chosen = n;
        ctx.watch(type.id, () => ctx.redraw());
        const inPlay = bands.filter((b) => isOn(b.params.type)).length;
        if (freq) ctx.io(freq).set(`${NEW_BAND_HZ[inPlay % NEW_BAND_HZ.length]} Hz`);
        ctx.io(type).set(onValue(type));
      });

      if (!svg) return;
      svg.querySelectorAll<SVGGElement>('[data-point]').forEach((point) => {
        const n = Number(point.dataset.point);
        const b = bands.find((x) => x.n === n);
        if (!b) return;
        // Sideways is frequency; up and down is gain, for shapes that have one.
        const dragTo = (e: PointerEvent) => {
          const box = svg.getBoundingClientRect();
          const x = Math.max(0, Math.min(1, (e.clientX - box.left) / box.width));
          const y = ((e.clientY - box.top) / box.height) * H;
          b.model.freq = xToFreq(x);
          if (b.params.freq) ctx.io(b.params.freq).set(`${Math.round(b.model.freq)} Hz`);
          if (b.params.gain && HAS_GAIN.has(b.model.shape)) {
            b.model.gainDb = Math.max(b.params.gain.min, Math.min(b.params.gain.max, dbOf(y)));
            ctx.io(b.params.gain).set(b.model.gainDb);
          }
          point.setAttribute('transform', pointAt(b.model));
          if (line) line.setAttribute('d', curvePath(bands));
        };
        let choose = false;
        onDrag(point, {
          // A new band is chosen on release, so the drag is not cut off by a redraw.
          start: () => (choose = chosen !== n),
          move: dragTo,
          end: () => {
            if (!choose) return;
            chosen = n;
            ctx.redraw();
          },
        });
      });
    },
  };
}
