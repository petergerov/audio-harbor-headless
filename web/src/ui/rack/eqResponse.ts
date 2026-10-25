/**
 * The frequency response of an equalizer, from its bands — for drawing its curve. Each band is
 * an RBJ biquad; a steeper slope is the same filter in series. It is a picture of what the
 * plugin does, close but not the plugin's own math.
 */

export type FilterShape = 'bell' | 'lowpass' | 'highpass' | 'lowshelf' | 'highshelf' | 'notch' | 'bandpass' | 'flat';

export interface EqBand {
  shape: FilterShape;
  /** Centre or corner, Hz. */
  freq: number;
  gainDb: number;
  q: number;
  /** Filters in series (the plugin's slope x1…x4). */
  order: number;
}

export const EQ_MIN_HZ = 20;
export const EQ_MAX_HZ = 20000;
/** The rate the curve is computed at; the drawing does not depend on the track's. */
const FS = 48000;

/** The plugin's filter names, as LSP and most EQs spell them. */
const SHAPES: Array<[RegExp, FilterShape]> = [
  [/^(bell|peak|resonance)/i, 'bell'],
  [/^(hi|high)[- ]?pass|^hpf?\b|low[- ]?cut/i, 'highpass'],
  [/^(lo|low)[- ]?pass|^lpf?\b|high[- ]?cut/i, 'lowpass'],
  [/^(hi|high)[- ]?shelf/i, 'highshelf'],
  [/^(lo|low)[- ]?shelf/i, 'lowshelf'],
  [/^notch/i, 'notch'],
  [/^band[- ]?pass/i, 'bandpass'],
];

export function shapeOf(name: string): FilterShape {
  return SHAPES.find(([pattern]) => pattern.test(name.trim()))?.[1] ?? 'flat';
}

/** A bandwidth in octaves as a Q. */
export function qFromOctaves(octaves: number): number {
  return 1 / (2 * Math.sinh((Math.LN2 / 2) * Math.max(octaves, 0.01)));
}

/** "1200 Hz", "1.20 kHz", "4.00 oct", "0.71" → the number in base units (Hz for k). */
export function numberIn(text: string): number {
  const match = /(-?\d+(?:\.\d+)?)\s*(k)?/i.exec(text);
  if (!match) return Number.NaN;
  return Number(match[1]) * (match[2] ? 1000 : 1);
}

type Coefficients = [b0: number, b1: number, b2: number, a0: number, a1: number, a2: number];

function coefficients(band: EqBand): Coefficients | null {
  const w0 = (2 * Math.PI * Math.min(band.freq, FS * 0.49)) / FS;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const q = band.q > 0 ? band.q : Math.SQRT1_2;
  const alpha = sin / (2 * q);
  const A = Math.pow(10, band.gainDb / 40);
  switch (band.shape) {
    case 'bell':
      return [1 + alpha * A, -2 * cos, 1 - alpha * A, 1 + alpha / A, -2 * cos, 1 - alpha / A];
    case 'lowpass':
      return [(1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + alpha, -2 * cos, 1 - alpha];
    case 'highpass':
      return [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha];
    case 'notch':
      return [1, -2 * cos, 1, 1 + alpha, -2 * cos, 1 - alpha];
    case 'bandpass':
      return [alpha, 0, -alpha, 1 + alpha, -2 * cos, 1 - alpha];
    case 'lowshelf':
    case 'highshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      const sign = band.shape === 'lowshelf' ? 1 : -1;
      return [
        A * (A + 1 - sign * (A - 1) * cos + s),
        sign * 2 * A * (A - 1 - sign * (A + 1) * cos),
        A * (A + 1 - sign * (A - 1) * cos - s),
        A + 1 + sign * (A - 1) * cos + s,
        -sign * 2 * (A - 1 + sign * (A + 1) * cos),
        A + 1 + sign * (A - 1) * cos - s,
      ];
    }
    default:
      return null;
  }
}

/** |H| in dB of one biquad at `freq`. */
function magnitudeDb(c: Coefficients, freq: number): number {
  const w = (2 * Math.PI * freq) / FS;
  const [b0, b1, b2, a0, a1, a2] = c;
  const re = (x0: number, x1: number, x2: number) => x0 + x1 * Math.cos(w) + x2 * Math.cos(2 * w);
  const im = (x1: number, x2: number) => -(x1 * Math.sin(w) + x2 * Math.sin(2 * w));
  const num = Math.hypot(re(b0, b1, b2), im(b1, b2));
  const den = Math.hypot(re(a0, a1, a2), im(a1, a2));
  return 20 * Math.log10(Math.max(num / den, 1e-6));
}

/** Frequencies spaced evenly on a log axis, for `points` samples of the curve. */
export function logFrequencies(points: number): number[] {
  const ratio = EQ_MAX_HZ / EQ_MIN_HZ;
  return Array.from({ length: points }, (_, i) => EQ_MIN_HZ * Math.pow(ratio, i / (points - 1)));
}

/** The summed response in dB at each frequency. */
export function response(bands: EqBand[], freqs: number[]): number[] {
  const filters = bands
    .map((b) => ({ c: coefficients(b), order: Math.max(1, b.order) }))
    .filter((f): f is { c: Coefficients; order: number } => f.c !== null);
  return freqs.map((f) => filters.reduce((sum, { c, order }) => sum + order * magnitudeDb(c, f), 0));
}

/** Position 0…1 of a frequency on the log axis, and back. */
export function freqToX(freq: number): number {
  return Math.log(freq / EQ_MIN_HZ) / Math.log(EQ_MAX_HZ / EQ_MIN_HZ);
}

export function xToFreq(x: number): number {
  return EQ_MIN_HZ * Math.pow(EQ_MAX_HZ / EQ_MIN_HZ, Math.min(1, Math.max(0, x)));
}
