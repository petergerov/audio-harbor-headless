import type { RackParam } from '../../api/types';

/** How a parameter is operated: a switch, a list of named values, or a number on a scale. */
export type ControlKind = 'toggle' | 'choice' | 'number';

/** Maps a value to a position 0…1 on a control and back, and steps it for the − / + keys. */
export interface Scale {
  toPosition(value: number): number;
  toValue(position: number): number;
  step(value: number, direction: -1 | 1): number;
}

/** A parameter with what the controls need to know about it. */
export interface ParamView {
  param: RackParam;
  kind: ControlKind;
  scale: Scale;
  /** "dB", "Hz", "%", "ms", or empty — read from the plugin's text. */
  unit: string;
}

/**
 * Parameters that only drive the plugin's own window (graphs, zoom, colours, inspectors).
 * The remote shows no such window, so they are left out.
 */
const DISPLAY_ONLY = [
  /\bgraph\b/i,
  /\boverlay\b/i,
  /\bzoom\b/i,
  /^hue\b/i,
  /\binspect/i,
  /\bvisibility\b/i,
  /^show\b/i,
  /\bfft reactivity\b/i,
  /^quantize note/i,
  /^filter select$/i,
  /^band selection$/i,
  /^band filter curves$/i,
  /\bcompatible with version\b/i,
  /\banaly[sz]er\b/i,
  /^display\b/i,
];

/** The plugin's own bypass: the rack's power key does that job. */
const BYPASS = /^bypass$/i;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export function isShown(param: RackParam): boolean {
  if (param.isBypass || BYPASS.test(param.name)) return false;
  return !DISPLAY_ONLY.some((pattern) => pattern.test(param.name));
}

export function kindOf(param: RackParam): ControlKind {
  const options = param.options ?? [];
  if (options.length === 2 && param.min === 0 && param.max === 1) return 'toggle';
  if (options.length >= 2) return 'choice';
  return 'number';
}

/** The unit at the end of the plugin's text: "-3.50 dB" → "dB", "100 %" → "%". */
export function unitOf(text: string): string {
  const match = /(%|[A-Za-zµ]+)\s*$/.exec(text.trim());
  if (!match) return '';
  const unit = match[1] ?? '';
  // "-inf dB" ends in a unit; "Bell" or "on" is a name, not a unit.
  return /^(dB|Hz|kHz|ms|s|%|oct|st|ct|cents?|x)$/i.test(unit) ? unit : '';
}

class LinearScale implements Scale {
  constructor(
    private readonly min: number,
    private readonly max: number,
    private readonly increment: number
  ) {}

  toPosition(value: number): number {
    return this.max > this.min ? clamp01((value - this.min) / (this.max - this.min)) : 0;
  }

  toValue(position: number): number {
    return this.min + clamp01(position) * (this.max - this.min);
  }

  step(value: number, direction: -1 | 1): number {
    return Math.min(this.max, Math.max(this.min, value + direction * this.increment));
  }
}

/** Frequencies: each octave takes the same width, so 20 Hz – 1 kHz is not a sliver. */
class LogScale implements Scale {
  /** A semitone per − / + press. */
  private static readonly RATIO = Math.pow(2, 1 / 12);

  constructor(
    private readonly min: number,
    private readonly max: number
  ) {}

  toPosition(value: number): number {
    return clamp01(Math.log(Math.max(value, this.min) / this.min) / Math.log(this.max / this.min));
  }

  toValue(position: number): number {
    return this.min * Math.pow(this.max / this.min, clamp01(position));
  }

  step(value: number, direction: -1 | 1): number {
    const next = direction > 0 ? value * LogScale.RATIO : value / LogScale.RATIO;
    return Math.min(this.max, Math.max(this.min, next));
  }
}

/** Snaps to the default (0 dB, centre balance, 1 kHz) when the control lands close to it. */
class DetentScale implements Scale {
  /** How close, as a share of the control's travel. */
  private static readonly CATCH = 0.015;

  constructor(
    private readonly inner: Scale,
    private readonly at: number
  ) {}

  toPosition(value: number): number {
    return this.inner.toPosition(value);
  }

  toValue(position: number): number {
    const detent = this.inner.toPosition(this.at);
    return Math.abs(position - detent) < DetentScale.CATCH ? this.at : this.inner.toValue(position);
  }

  step(value: number, direction: -1 | 1): number {
    return this.inner.step(value, direction);
  }
}

function linearIncrement(param: RackParam, unit: string): number {
  if (param.stepped) return 1;
  const span = param.max - param.min;
  // Half a dB is a step one hears; a hundredth of the travel otherwise.
  if (/^dB$/i.test(unit) && span >= 12) return 0.5;
  return span / 100;
}

export function scaleFor(param: RackParam, unit: string): Scale {
  const isFrequency = /^k?Hz$/i.test(unit);
  const base: Scale =
    isFrequency && param.min > 0 && param.max / param.min >= 50
      ? new LogScale(param.min, param.max)
      : new LinearScale(param.min, param.max, linearIncrement(param, unit));
  const inside = param.default > param.min && param.default < param.max;
  return inside && !param.stepped ? new DetentScale(base, param.default) : base;
}

export function viewOf(param: RackParam): ParamView {
  const unit = unitOf(param.text);
  return { param, kind: kindOf(param), scale: scaleFor(param, unit), unit };
}
