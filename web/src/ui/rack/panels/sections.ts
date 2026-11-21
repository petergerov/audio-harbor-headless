import { escapeHtml } from '../../../core/html';
import type { RackParam } from '../../../api/types';
import { bindFader, faderHtml, showFader } from '../fader';
import { bindKnob, knobHtml, showKnob } from '../knob';
import { meterHtml } from '../meter';
import { CONTROLS } from '../paramControls';
import { scaleBetween, viewOf } from '../paramModel';
import { bindParamRow, paramRowHtml } from '../paramRow';
import { spectrumPathsHtml, spectrumTogglesHtml } from '../spectrumDraw';
import { bandTabsSection } from './bandStrip';
import { eqCurveSection } from './eqCurve';
import type { PanelContext, Section, SectionRenderer } from './panelSpec';

const GEQ_SPEC_W = 600;
const GEQ_SPEC_H = 160;

type Named = string | [name: string, label: string];
const named = (entry: Named): [string, string] => (typeof entry === 'string' ? [entry, entry] : entry);

/** The parameters of `entries` the plugin has, with their labels. */
function present(entries: Named[], ctx: PanelContext): Array<[RackParam, string]> {
  return entries
    .map(named)
    .map(([name, label]): [RackParam | undefined, string] => [ctx.param(name), label])
    .filter((pair): pair is [RackParam, string] => pair[0] !== undefined);
}

const title = (text?: string) => (text ? `<p class="group-label panel-title">${escapeHtml(text)}</p>` : '');

export function knobsHtml(params: Array<[RackParam, string]>): string {
  return params.length
    ? `<div class="rack-knobs compact">${params.map(([p, label]) => knobHtml(viewOf(p), label)).join('')}</div>`
    : '';
}

export function bindKnobs(root: HTMLElement, params: Array<[RackParam, string]>, ctx: PanelContext): void {
  for (const [param] of params) {
    const knob = root.querySelector<HTMLElement>(`[data-knob="${CSS.escape(param.id)}"]`);
    if (!knob) continue;
    bindKnob(knob, viewOf(param), ctx.io(param));
    ctx.watch(param.id, (answer) => showKnob(knob, answer));
  }
}

export function rowsHtml(params: Array<[RackParam, string]>): string {
  return params.map(([p, label]) => paramRowHtml(viewOf(p), { pinnable: false, label })).join('');
}

export function bindRows(root: HTMLElement, params: Array<[RackParam, string]>, ctx: PanelContext): void {
  for (const [param] of params) {
    const row = root.querySelector<HTMLElement>(`[data-param-row="${CSS.escape(param.id)}"]`);
    if (!row) continue;
    const view = viewOf(param);
    bindParamRow(row, view, ctx.io(param));
    ctx.watch(param.id, (answer) => CONTROLS[view.kind].show(row, viewOf(answer)));
  }
}

const note: SectionRenderer<Extract<Section, { kind: 'note' }>> = {
  html: (s) => `<p class="panel-note">${escapeHtml(s.text)}</p>`,
  bind: () => {},
};

const meter: SectionRenderer<Extract<Section, { kind: 'meter' }>> = {
  html: () => meterHtml(),
  bind: (root, _s, ctx) => {
    const el = root.querySelector<HTMLElement>('[data-meter]');
    if (el) ctx.startMeter(el);
  },
};

const SPEC_W = 600;
const SPEC_H = 180;

const spectrum: SectionRenderer<Extract<Section, { kind: 'spectrum' }>> = {
  html: () => `
    <div class="spec-stage" data-spec-only>
      ${spectrumTogglesHtml()}
      <svg class="geq-spectrum tall" viewBox="0 0 ${SPEC_W} ${SPEC_H}" preserveAspectRatio="none" aria-hidden="true">
        ${spectrumPathsHtml()}
      </svg>
    </div>`,
  bind: (root, _s, ctx) => {
    const el = root.querySelector<HTMLElement>('[data-spec-only]');
    if (el) ctx.startSpectrum(el, SPEC_W, SPEC_H);
  },
};

const knobs: SectionRenderer<Extract<Section, { kind: 'knobs' }>> = {
  html: (s, ctx) => title(s.title) + knobsHtml(present(s.params, ctx)),
  bind: (root, s, ctx) => bindKnobs(root, present(s.params, ctx), ctx),
};

const rows: SectionRenderer<Extract<Section, { kind: 'rows' }>> = {
  html: (s, ctx) => {
    const found = present(s.params, ctx);
    return found.length ? `${title(s.title)}<div class="panel-rows">${rowsHtml(found)}</div>` : '';
  },
  bind: (root, s, ctx) => bindRows(root, present(s.params, ctx), ctx),
};

/** "Band gain 1.6K" → "1.6k". */
const faderLabel = (name: string) => (/\s(\S+)$/.exec(name)?.[1] ?? name).replace(/K$/, 'k');

const faders: SectionRenderer<Extract<Section, { kind: 'faders' }>> = {
  html: (s, ctx) => {
    const found = matching(s.match, ctx);
    return `${title(s.title)}
      <div class="geq-wrap" data-geq>
        ${spectrumTogglesHtml()}
        <svg class="geq-spectrum" viewBox="0 0 ${GEQ_SPEC_W} ${GEQ_SPEC_H}" preserveAspectRatio="none" aria-hidden="true">
          ${spectrumPathsHtml()}
        </svg>
        <div class="rack-faders compact">${found
          .map((p) => faderHtml(p.id, faderLabel(p.name), p.text))
          .join('')}</div>
      </div>`;
  },
  bind: (root, s, ctx) => {
    const wrap = root.querySelector<HTMLElement>('[data-geq]');
    if (wrap) ctx.startSpectrum(wrap, GEQ_SPEC_W, GEQ_SPEC_H);
    const scale = scaleBetween(-s.range, s.range, 0.5, 0);
    for (const param of matching(s.match, ctx)) {
      const fader = root.querySelector<HTMLElement>(`[data-fader="${CSS.escape(param.id)}"]`);
      if (!fader) continue;
      bindFader(fader, scale, param.value, param.default, ctx.io(param));
      ctx.watch(param.id, (answer) => showFader(fader, answer.text));
    }
  },
};

/** Parameters of the panel's plugin whose name matches, in the plugin's order. */
function matching(pattern: RegExp, ctx: PanelContext): RackParam[] {
  return ctx.all().filter((p) => pattern.test(p.name));
}

/** A renderer per kind of section — a new kind is a new entry. Stateful ones are made per panel. */
export function sectionRenderers(): { [K in Section['kind']]: SectionRenderer<Extract<Section, { kind: K }>> } {
  return { note, meter, spectrum, knobs, rows, faders, eqCurve: eqCurveSection(), bandTabs: bandTabsSection() };
}

