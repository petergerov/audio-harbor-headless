import type { RackApi } from '../../api/rackApi';
import type { RackParam, RackSnapshot } from '../../api/types';
import { errorMessage } from '../../core/errors';
import { escapeAttr, escapeHtml, required } from '../../core/html';
import { icons } from '../icons';
import { openPanel, showToast } from '../overlay';
import { CONTROLS } from './paramControls';
import { groupParams, onValue, shortName, type ParamGroup } from './paramGroups';
import { isShown, viewOf, type ParamView } from './paramModel';
import { bindParamRow, paramRowHtml } from './paramRow';
import { ParamSender } from './paramSender';

export const MAX_PINNED = 6;
/** Up to this many bands in play open when the sheet opens. */
const OPEN_BANDS = 6;

interface SheetState {
  params: RackParam[];
  pins: string[];
  query: string;
  showUnused: boolean;
}

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
export function openParamSheet(
  rack: RackApi,
  insert: { id: string; name: string },
  pinned: string[],
  onPinned: (snapshot: RackSnapshot) => void
): void {
  const state: SheetState = { params: [], pins: [...pinned], query: '', showUnused: false };
  openPanel({
    title: insert.name,
    subtitle: 'Parameters',
    bodyHtml: `
      <div class="rack-sheet">
        <div class="search-wrap rack-search">${icons.search}
          <input type="search" data-param-search placeholder="Find a parameter" aria-label="Find a parameter" />
        </div>
        <p class="rack-pin-note" data-pin-note></p>
        <div data-param-list><p class="rack-empty">Asking the plugin…</p></div>
      </div>
    `,
    bind: (root) => {
      const list = required(root, '[data-param-list]');
      const search = required<HTMLInputElement>(root, '[data-param-search]');
      const note = required(root, '[data-pin-note]');
      let groups: ParamGroup[] = [];

      const reload = async () => {
        state.params = (await rack.params(insert.id)).filter(isShown);
        paint();
      };

      // An answer from the plugin: its value and text into the row. A band switched on or off
      // moves between in play and unused, so the list is drawn again.
      const sender = new ParamSender(rack, insert.id, (answer) => {
        const index = state.params.findIndex((p) => p.id === answer.id);
        if (index >= 0) state.params[index] = { ...state.params[index], ...answer };
        if (groups.some((g) => g.activator?.id === answer.id)) {
          paint();
          return;
        }
        const row = list.querySelector<HTMLElement>(`[data-param-row="${CSS.escape(answer.id)}"]`);
        if (row) {
          const view = viewOf(answer);
          CONTROLS[view.kind].show(row, view);
        }
      });

      const togglePin = async (id: string) => {
        const next = state.pins.includes(id) ? state.pins.filter((p) => p !== id) : [...state.pins, id];
        if (next.length > MAX_PINNED) {
          showToast(`Up to ${MAX_PINNED} knobs on the rack sheet — unpin one first`);
          return;
        }
        try {
          onPinned(await rack.setPinned(insert.id, next));
          state.pins = next;
          paint();
        } catch (err) {
          showToast(errorMessage(err, 'Could not pin it'), { error: true });
        }
      };

      const addBand = async (group: ParamGroup) => {
        if (!group.activator) return;
        try {
          await rack.setParam(insert.id, group.activator.id, onValue(group.activator));
          await reload();
        } catch (err) {
          showToast(errorMessage(err, 'Could not switch the band on'), { error: true });
        }
      };

      const paint = () => {
        note.textContent = `${state.pins.length} of ${MAX_PINNED} pinned · hold a name or tap ★ to pin`;
        groups = groupParams(state.params);
        const views = new Map(state.params.map((p) => [p.id, viewOf(p)]));
        const viewsOf = (g: ParamGroup) => g.params.map((p) => views.get(p.id)).filter((v): v is ParamView => !!v);
        const query = state.query.trim();
        let html = '';
        if (query) {
          html = groups
            .map((g) => ({ g, found: viewsOf(g).filter((v) => matches(v, g, query)) }))
            .filter(({ found }) => found.length)
            .map(({ g, found }) => groupHtml(g, found, state.pins, true))
            .join('');
        } else {
          const unused = groups.filter((g) => !g.active);
          // A few bands in play open at once; many (a 16-band graphic EQ) start closed.
          const openBands = groups.filter((g) => g.key && g.active).length <= OPEN_BANDS;
          html = groups
            .filter((g) => g.active || state.showUnused)
            .map((g) => groupHtml(g, viewsOf(g), state.pins, g.active && openBands))
            .join('');
          if (unused.length) {
            html += `
              <div class="param-unused">
                ${unused[0]?.activator ? `<button type="button" class="btn-text" data-add-band="${escapeAttr(unused[0].key)}">+ ${escapeHtml(unused[0].label)}</button>` : ''}
                <button type="button" class="btn-text" data-show-unused>${state.showUnused ? 'Hide' : 'Show'} ${unused.length} unused</button>
              </div>`;
          }
        }
        list.innerHTML = html || `<p class="rack-empty">${state.params.length ? 'No parameter matches.' : 'This plugin shows no parameters.'}</p>`;

        list.querySelectorAll<HTMLElement>('[data-param-row]').forEach((row) => {
          const view = views.get(row.dataset.paramRow ?? '');
          if (!view) return;
          bindParamRow(
            row,
            view,
            { set: (value) => sender.set(view.param.id, value), setText: (text) => sender.setText(view.param.id, text) },
            () => void togglePin(view.param.id)
          );
        });
        list.querySelector('[data-show-unused]')?.addEventListener('click', () => {
          state.showUnused = !state.showUnused;
          paint();
        });
        list.querySelector<HTMLElement>('[data-add-band]')?.addEventListener('click', (e) => {
          const group = groups.find((g) => g.key === (e.currentTarget as HTMLElement).dataset.addBand);
          if (group) void addBand(group);
        });
      };

      search.addEventListener('input', () => {
        state.query = search.value;
        paint();
      });
      void reload().catch((err) => {
        list.innerHTML = `<p class="rack-empty">${escapeHtml(errorMessage(err, 'The plugin did not answer'))}</p>`;
      });
    },
  });
}
