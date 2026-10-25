import { escapeHtml } from '../../../core/html';
import type { RackParam } from '../../../api/types';
import { bindFader, faderHtml, showFader } from '../fader';
import { bindKnob, knobHtml, showKnob } from '../knob';
import { meterHtml } from '../meter';
import { CONTROLS } from '../paramControls';
import { isOn, onValue } from '../paramGroups';
import { scaleBetween, viewOf } from '../paramModel';
import { bindParamRow, paramRowHtml } from '../paramRow';
import { eqCurveSection } from './eqCurve';
import { bandName, type PanelContext, type Section, type SectionRenderer } from './panelSpec';

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
    ? `<div class="rack-knobs">${params.map(([p, label]) => knobHtml(viewOf(p), label)).join('')}</div>`
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
    return `${title(s.title)}<div class="rack-faders">${found
      .map((p) => faderHtml(p.id, faderLabel(p.name), p.text))
      .join('')}</div>`;
  },
  bind: (root, s, ctx) => {
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

/** Bands of a multiband plugin: a tab per band in play, the chosen one's knobs and rows. */
function bandTabsSection(): SectionRenderer<Extract<Section, { kind: 'bandTabs' }>> {
  let chosen: number | null = null;
  const bands = (s: Extract<Section, { kind: 'bandTabs' }>, ctx: PanelContext) =>
    Array.from({ length: s.count }, (_, i) => s.first + i).map((n) => {
      const enable = s.enable ? ctx.param(bandName(s.enable, n)) : undefined;
      const on = s.alwaysOn?.includes(n) || !enable || isOn(enable);
      return { n, enable, on };
    });
  const forBand = (entries: Array<[string, string]>, n: number): Named[] =>
    entries.map(([name, label]) => [bandName(name, n), label]);
  return {
    html: (s, ctx) => {
      const all = bands(s, ctx);
      const inPlay = all.filter((b) => b.on);
      if (chosen === null || !inPlay.some((b) => b.n === chosen)) chosen = inPlay[0]?.n ?? s.first;
      const next = all.find((b) => !b.on && b.enable);
      const tabs = inPlay
        .map((b) => `<button type="button" class="deck-pill ${b.n === chosen ? 'is-on' : ''}" data-band="${b.n}">${b.n}</button>`)
        .join('');
      const add = next ? `<button type="button" class="deck-pill" data-band-add="${next.n}" aria-label="Add band ${next.n}">+</button>` : '';
      const n = chosen;
      return `
        <div class="band-tabs" role="tablist">${tabs}${add}</div>
        ${knobsHtml(present(forBand(s.knobs, n), ctx))}
        <div class="panel-rows">${rowsHtml(present(forBand(s.rows ?? [], n), ctx))}</div>`;
    },
    bind: (root, s, ctx) => {
      const n = chosen ?? s.first;
      bindKnobs(root, present(forBand(s.knobs, n), ctx), ctx);
      bindRows(root, present(forBand(s.rows ?? [], n), ctx), ctx);
      root.querySelectorAll<HTMLElement>('[data-band]').forEach((tab) =>
        tab.addEventListener('click', () => {
          chosen = Number(tab.dataset.band);
          ctx.redraw();
        })
      );
      root.querySelector<HTMLElement>('[data-band-add]')?.addEventListener('click', (e) => {
        const band = Number((e.currentTarget as HTMLElement).dataset.bandAdd);
        const enable = s.enable ? ctx.param(bandName(s.enable, band)) : undefined;
        if (!enable) return;
        chosen = band;
        ctx.watch(enable.id, () => ctx.redraw());
        ctx.io(enable).set(onValue(enable));
      });
    },
  };
}

/** A renderer per kind of section — a new kind is a new entry. Stateful ones are made per panel. */
export function sectionRenderers(): { [K in Section['kind']]: SectionRenderer<Extract<Section, { kind: K }>> } {
  return { note, meter, knobs, rows, faders, eqCurve: eqCurveSection(), bandTabs: bandTabsSection() };
}

