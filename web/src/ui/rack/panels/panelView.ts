import type { RackApi } from '../../../api/rackApi';
import type { RackParam } from '../../../api/types';
import { runMeter } from '../meter';
import { ParamSender } from '../paramSender';
import type { InsertView } from '../insertView';
import type { PanelContext, PanelSpec, Section } from './panelSpec';
import { sectionRenderers } from './sections';

/** A plugin's own page, drawn from its spec; values come from the plugin and its answers. */
export class PanelView implements InsertView {
  private params: RackParam[] = [];
  private byName = new Map<string, RackParam>();
  private watchers = new Map<string, Array<(param: RackParam) => void>>();
  private readonly renderers = sectionRenderers();
  private readonly sender: ParamSender;
  private container: HTMLElement | null = null;

  constructor(
    private readonly rack: RackApi,
    private readonly insertId: string,
    private readonly spec: PanelSpec,
    onChange: () => void
  ) {
    this.sender = new ParamSender(rack, insertId, (answer) => this.answered(answer), onChange);
  }

  async mount(container: HTMLElement): Promise<void> {
    this.container = container;
    await this.reload();
  }

  async reload(): Promise<void> {
    this.params = await this.rack.params(this.insertId);
    this.byName = new Map(this.params.map((p) => [p.name, p]));
    this.draw();
  }

  private answered(answer: RackParam): void {
    const index = this.params.findIndex((p) => p.id === answer.id);
    if (index >= 0) {
      this.params[index] = { ...this.params[index], ...answer };
      this.byName.set(answer.name, this.params[index]);
    }
    for (const update of this.watchers.get(answer.id) ?? []) update(this.params[index] ?? answer);
  }

  private draw(): void {
    const container = this.container;
    if (!container) return;
    this.watchers.clear();
    const ctx = this.context();
    container.innerHTML = this.spec.sections
      .map((section, i) => `<div class="panel-section" data-section="${i}">${this.renderer(section).html(section, ctx)}</div>`)
      .join('');
    this.spec.sections.forEach((section, i) => {
      const root = container.querySelector<HTMLElement>(`[data-section="${i}"]`);
      if (root) this.renderer(section).bind(root, section, ctx);
    });
  }

  private renderer(section: Section) {
    // The registry is keyed by kind; the cast ties each kind to its own section type.
    return this.renderers[section.kind] as unknown as {
      html(s: Section, ctx: PanelContext): string;
      bind(root: HTMLElement, s: Section, ctx: PanelContext): void;
    };
  }

  private context(): PanelContext {
    return {
      param: (name) => this.byName.get(name),
      all: () => this.params,
      io: (param) => ({
        set: (value) => this.sender.set(param.id, value),
        setText: (text) => this.sender.setText(param.id, text),
      }),
      watch: (paramId, update) => this.watchers.set(paramId, [...(this.watchers.get(paramId) ?? []), update]),
      redraw: () => this.draw(),
      startMeter: (el) => runMeter(el, this.rack, this.insertId),
    };
  }
}
