import type { AppContext } from '../../app/context';
import type { RackApi } from '../../api/rackApi';
import type { RackInsert, RackSnapshot } from '../../api/types';
import { errorMessage } from '../../core/errors';
import { required } from '../../core/html';
import { bindPowerKeys, insertHeadHtml, rackPathHtml } from '../components/rackControls';
import { closeOverlay, openPanel, showToast } from '../overlay';
import { bindKnob, knobHtml, showKnob } from '../rack/knob';
import { CONTROLS } from '../rack/paramControls';
import { viewOf } from '../rack/paramModel';
import { bindParamRow, paramRowHtml } from '../rack/paramRow';
import { ParamSender, trackHolds } from '../rack/paramSender';

/** Pinned numbers as knobs in a row; pinned switches and choices as compact rows below. */
function pinnedHtml(insert: RackInsert): string {
  const views = insert.pinned.map(viewOf);
  const knobs = views.filter((v) => v.kind === 'number').map(knobHtml).join('');
  const rows = views
    .filter((v) => v.kind !== 'number')
    .map((v) => paramRowHtml(v, { pinnable: false }))
    .join('');
  return `${knobs ? `<div class="rack-knobs">${knobs}</div>` : ''}${rows}`;
}

/** Each insert's pinned controls send through its own sender; answers update them in place. */
function bindPinned(body: HTMLElement, rack: RackApi, snapshot: RackSnapshot): void {
  for (const insert of snapshot.inserts) {
    const block = body.querySelector<HTMLElement>(`[data-insert-block="${CSS.escape(insert.id)}"]`);
    if (!block) continue;
    const sender = new ParamSender(rack, insert.id, (answer) => {
      const knob = block.querySelector<HTMLElement>(`[data-knob="${CSS.escape(answer.id)}"]`);
      if (knob) showKnob(knob, answer);
      const row = block.querySelector<HTMLElement>(`[data-param-row="${CSS.escape(answer.id)}"]`);
      if (row) {
        const view = viewOf(answer);
        CONTROLS[view.kind].show(row, view);
      }
    });
    for (const param of insert.pinned) {
      const view = viewOf(param);
      const io = { set: (value: number) => sender.set(param.id, value), setText: (text: string) => sender.setText(param.id, text) };
      const knob = block.querySelector<HTMLElement>(`[data-knob="${CSS.escape(param.id)}"]`);
      if (knob) bindKnob(knob, view, io);
      const row = block.querySelector<HTMLElement>(`[data-param-row="${CSS.escape(param.id)}"]`);
      if (row) bindParamRow(row, view, io);
    }
  }
}

function bodyHtml(rack: RackSnapshot): string {
  const inserts = rack.inserts
    .map(
      (insert, index) => `
      <div class="rack-insert" data-insert-block="${insert.id}">
        <div class="rack-insert-head">${insertHeadHtml(insert, index)}</div>
        ${pinnedHtml(insert)}
      </div>`
    )
    .join('');
  return `
    ${rackPathHtml(rack)}
    <button type="button" class="rack-ab ${rack.bypassed ? '' : 'is-on'}" data-ab aria-pressed="${!rack.bypassed}"
      ${rack.inserts.length ? '' : 'disabled'}>
      <span class="rack-ab-key"></span>
      <span>${rack.bypassed ? 'Rack Bypassed — tap for Plugins' : 'Plugins In — tap to Compare'}</span>
    </button>
    ${
      rack.inserts.length
        ? `<div class="ah-group rack-inserts">${inserts}</div>`
        : `<p class="rack-empty">No plugins in the rack. The file reaches the output untouched.</p>`
    }
    <button type="button" class="ah-row rack-edit" data-edit>Edit Rack…</button>
  `;
}

/**
 * The rack from the Deck: the path, one key that takes the whole rack out and back in for an
 * A/B without a gap, each insert's power key and its pinned knobs. Follows the host while open.
 */
export function openRackSheet(ctx: AppContext): void {
  const rack = ctx.store.get().rack;
  if (!rack) return;
  openPanel({
    title: 'Plugin Rack',
    bodyHtml: `<div data-rack-body>${bodyHtml(rack)}</div>`,
    bind: (root) => {
      const body = required(root, '[data-rack-body]');
      const held = trackHolds(body);
      const paint = (snapshot: RackSnapshot) => {
        body.innerHTML = bodyHtml(snapshot);
        bindPinned(body, ctx.rack, snapshot);
        bindPowerKeys(body, ctx.rack, () => ctx.store.get().rack);
        body.querySelector('[data-ab]')?.addEventListener('click', async () => {
          const current = ctx.store.get().rack;
          if (!current) return;
          try {
            ctx.store.update({ rack: await ctx.rack.setBypass(!current.bypassed) });
          } catch (err) {
            showToast(errorMessage(err, 'Could not switch the rack'), { error: true });
          }
        });
        body.querySelector('[data-edit]')?.addEventListener('click', () => {
          closeOverlay();
          ctx.store.update({ settingsPane: 'rack' });
          void ctx.nav.goTo('settings');
        });
      };
      paint(rack);
      const unsubscribe = ctx.store.subscribe((state, previous) => {
        if (!body.isConnected) {
          unsubscribe();
          return;
        }
        // A knob being dragged is not repainted under the finger.
        if (state.rack && state.rack !== previous.rack && !held()) paint(state.rack);
      });
    },
  });
}
