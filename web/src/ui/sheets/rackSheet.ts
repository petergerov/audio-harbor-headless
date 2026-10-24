import type { AppContext } from '../../app/context';
import type { RackSnapshot } from '../../api/types';
import { errorMessage } from '../../core/errors';
import { required } from '../../core/html';
import {
  bindParamSliders,
  bindPowerKeys,
  insertHeadHtml,
  paramSliderHtml,
  rackPathHtml,
} from '../components/rackControls';
import { closeOverlay, openPanel, showToast } from '../overlay';

function bodyHtml(rack: RackSnapshot): string {
  const inserts = rack.inserts
    .map(
      (insert, index) => `
      <div class="rack-insert">
        <div class="rack-insert-head">${insertHeadHtml(insert, index)}</div>
        ${insert.pinned.map((p) => paramSliderHtml(insert.id, p)).join('')}
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
      let held = () => false;
      const paint = (snapshot: RackSnapshot) => {
        body.innerHTML = bodyHtml(snapshot);
        held = bindParamSliders(body, ctx.rack);
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
