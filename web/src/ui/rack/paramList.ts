import type { RackApi } from '../../api/rackApi';
import type { RackParam, RackSnapshot } from '../../api/types';
import { errorMessage } from '../../core/errors';
import { escapeAttr, escapeHtml, required } from '../../core/html';
import { icons } from '../icons';
import { showToast } from '../overlay';
import type { InsertView } from './insertView';
import { CONTROLS } from './paramControls';
import { groupParams, onValue, shortName, type ParamGroup } from './paramGroups';
import { isShown, viewOf, type ParamView } from './paramModel';
import { bindParamRow, paramRowHtml } from './paramRow';
import { ParamSender } from './paramSender';

export const MAX_PINNED = 6;
/** Up to this many bands in play open when the list opens. */
const OPEN_BANDS = 6;

function matches(view: ParamView, group: ParamGroup, query: string): boolean {
  const q = query.toLowerCase();
  return view.param.name.toLowerCase().includes(q) || group.label.toLowerCase().includes(q);
}

/** One group: its label, then its rows; Main and bands in play open, unused ones closed. */
function groupHtml(group: ParamGroup, views: ParamView[], pins: string[], open: boolean): string {
  const rows = views
    .map((v) => paramRowHtml(v, { pinnable: true, pinned: pins.includes(v.param.id), label: shortName(v.param, group) }))
    .join('');
  if (group.key === '') return `<div class="param-group main">${rows}</div>`;
  return `
    <details class="param-group ${group.active ? '' : 'is-unused'}" ${open ? 'open' : ''}>
      <summary>${escapeHtml(group.label)}${group.active ? '' : '<span class="param-group-note">unused</span>'}</summary>
      ${rows}
    </details>`;
}

/**
 * Every parameter of one insert, with the control its kind wants: switches, named choices,
 * sliders on the right scale with − / +, values to type. Display-only parameters are left
 * out; bands in play are shown, unused ones wait behind "+ Band" or "Show unused".
 */
export class ParamListView implements InsertView {
  private params: RackParam[] = [];
  private pins: string[];
  private query = '';
  private showUnused = false;
  private groups: ParamGroup[] = [];
  private readonly sender: ParamSender;
  private list: HTMLElement | null = null;
  private note: HTMLElement | null = null;

  constructor(
    private readonly rack: RackApi,
    private readonly insertId: string,
    pinned: string[],
    private readonly onPinned: (snapshot: RackSnapshot) => void,
    onChange: () => void
  ) {
    this.pins = [...pinned];
    this.sender = new ParamSender(rack, insertId, (answer) => this.answered(answer), onChange);
  }

  async mount(container: HTMLElement): Promise<void> {
    container.innerHTML = `
      <div class="search-wrap rack-search">${icons.search}
        <input type="search" data-param-search placeholder="Find a parameter" aria-label="Find a parameter" />
      </div>
      <p class="rack-pin-note" data-pin-note></p>
      <div data-param-list><p class="rack-empty">Asking the plugin…</p></div>`;
    const list = required<HTMLElement>(container, '[data-param-list]');
    this.list = list;
    this.note = required<HTMLElement>(container, '[data-pin-note]');
    const search = required<HTMLInputElement>(container, '[data-param-search]');
    search.addEventListener('input', () => {
      this.query = search.value;
      this.paint();
    });
    try {
      await this.reload();
    } catch (err) {
      list.innerHTML = `<p class="rack-empty">${escapeHtml(errorMessage(err, 'The plugin did not answer'))}</p>`;
    }
  }

  async reload(): Promise<void> {
    this.params = (await this.rack.params(this.insertId)).filter(isShown);
    this.paint();
  }

  /** The plugin's answer into its row; a band switched on or off moves, so the list redraws. */
  private answered(answer: RackParam): void {
    const index = this.params.findIndex((p) => p.id === answer.id);
    if (index >= 0) this.params[index] = { ...this.params[index], ...answer };
    if (this.groups.some((g) => g.activator?.id === answer.id)) {
      this.paint();
      return;
    }
    const row = this.list?.querySelector<HTMLElement>(`[data-param-row="${CSS.escape(answer.id)}"]`);
    if (row) {
      const view = viewOf(answer);
      CONTROLS[view.kind].show(row, view);
    }
  }

  private async togglePin(id: string): Promise<void> {
    const next = this.pins.includes(id) ? this.pins.filter((p) => p !== id) : [...this.pins, id];
    if (next.length > MAX_PINNED) {
      showToast(`Up to ${MAX_PINNED} knobs on the rack sheet — unpin one first`);
      return;
    }
    try {
      this.onPinned(await this.rack.setPinned(this.insertId, next));
      this.pins = next;
      this.paint();
    } catch (err) {
      showToast(errorMessage(err, 'Could not pin it'), { error: true });
    }
  }

  private async addBand(group: ParamGroup): Promise<void> {
    if (!group.activator) return;
    try {
      await this.rack.setParam(this.insertId, group.activator.id, onValue(group.activator));
      await this.reload();
    } catch (err) {
      showToast(errorMessage(err, 'Could not switch the band on'), { error: true });
    }
  }

  private paint(): void {
    const list = this.list;
    if (!list || !this.note) return;
    this.note.textContent = `${this.pins.length} of ${MAX_PINNED} pinned · hold a name or tap ★ to pin`;
    this.groups = groupParams(this.params);
    const views = new Map(this.params.map((p) => [p.id, viewOf(p)]));
    const viewsOf = (g: ParamGroup) => g.params.map((p) => views.get(p.id)).filter((v): v is ParamView => !!v);
    list.innerHTML = this.query.trim() ? this.searchHtml(viewsOf) : this.groupsHtml(viewsOf);
    if (!list.innerHTML.trim()) {
      list.innerHTML = `<p class="rack-empty">${this.params.length ? 'No parameter matches.' : 'This plugin shows no parameters.'}</p>`;
    }
    list.querySelectorAll<HTMLElement>('[data-param-row]').forEach((row) => {
      const view = views.get(row.dataset.paramRow ?? '');
      if (!view) return;
      bindParamRow(
        row,
        view,
        { set: (value) => this.sender.set(view.param.id, value), setText: (text) => this.sender.setText(view.param.id, text) },
        () => void this.togglePin(view.param.id)
      );
    });
    list.querySelector('[data-show-unused]')?.addEventListener('click', () => {
      this.showUnused = !this.showUnused;
      this.paint();
    });
    list.querySelector<HTMLElement>('[data-add-band]')?.addEventListener('click', (e) => {
      const group = this.groups.find((g) => g.key === (e.currentTarget as HTMLElement).dataset.addBand);
      if (group) void this.addBand(group);
    });
  }

  private searchHtml(viewsOf: (g: ParamGroup) => ParamView[]): string {
    const query = this.query.trim();
    return this.groups
      .map((g) => ({ g, found: viewsOf(g).filter((v) => matches(v, g, query)) }))
      .filter(({ found }) => found.length)
      .map(({ g, found }) => groupHtml(g, found, this.pins, true))
      .join('');
  }

  private groupsHtml(viewsOf: (g: ParamGroup) => ParamView[]): string {
    const unused = this.groups.filter((g) => !g.active);
    // A few bands in play open at once; many (a 16-band graphic EQ) start closed.
    const openBands = this.groups.filter((g) => g.key && g.active).length <= OPEN_BANDS;
    let html = this.groups
      .filter((g) => g.active || this.showUnused)
      .map((g) => groupHtml(g, viewsOf(g), this.pins, g.active && openBands))
      .join('');
    if (unused.length) {
      const next = unused.find((g) => g.activator);
      html += `
        <div class="param-unused">
          ${next ? `<button type="button" class="btn-text" data-add-band="${escapeAttr(next.key)}">+ ${escapeHtml(next.label)}</button>` : ''}
          <button type="button" class="btn-text" data-show-unused>${this.showUnused ? 'Hide' : 'Show'} ${unused.length} unused</button>
        </div>`;
    }
    return html;
  }
}
