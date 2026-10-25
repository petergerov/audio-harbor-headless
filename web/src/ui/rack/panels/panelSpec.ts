import type { RackParam } from '../../../api/types';
import type { ParamIO } from '../paramControls';

/**
 * A plugin's own page, as data: which parameters, in which kind of section. Names are the
 * plugin's; `#` in a name stands for a band's number.
 */
export interface PanelSpec {
  sections: Section[];
}

/** The parameters of one EQ band, by name with `#` for its number. */
export interface EqBandNames {
  type: string;
  freq: string;
  gain: string;
  q?: string;
  width?: string;
  slope?: string;
}

export type Section =
  /** A short line on what the plugin is for. */
  | { kind: 'note'; text: string }
  /** In, out and gain change of this insert, live. */
  | { kind: 'meter' }
  | { kind: 'knobs'; title?: string; params: Array<string | [name: string, label: string]> }
  | { kind: 'rows'; title?: string; params: Array<string | [name: string, label: string]> }
  /** Every parameter matching `match` as a fader over ±`range` dB, labelled by its trailing token. */
  | { kind: 'faders'; title?: string; match: RegExp; range: number }
  /** The curve of bands `first`…`first + count - 1`, their points to drag, the chosen band's controls. */
  | { kind: 'eqCurve'; bands: EqBandNames; first: number; count: number }
  /** A tab per band in play, the chosen band's knobs; `enable` names a band's on switch (null: always on). */
  | {
      kind: 'bandTabs';
      first: number;
      count: number;
      enable: string | null;
      knobs: Array<[name: string, label: string]>;
      rows?: Array<[name: string, label: string]>;
      alwaysOn?: number[];
    };

/** What a section works with: the values, a way to change them, and their answers. */
export interface PanelContext {
  /** The value as last reported, by the plugin's name for it. */
  param(name: string): RackParam | undefined;
  /** Every parameter, in the plugin's order. */
  all(): RackParam[];
  io(param: RackParam): ParamIO;
  /** Called with the plugin's answer each time `paramId` changes. */
  watch(paramId: string, update: (param: RackParam) => void): void;
  /** Draws the whole panel again (a band switched on, a tab chosen). */
  redraw(): void;
  /** Starts the live meter in `el`. */
  startMeter(el: HTMLElement): void;
}

/** One kind of section: its markup, then its wiring. */
export interface SectionRenderer<S extends Section = Section> {
  html(section: S, ctx: PanelContext): string;
  bind(root: HTMLElement, section: S, ctx: PanelContext): void;
}

export const bandName = (pattern: string, n: number) => pattern.replace('#', String(n));
