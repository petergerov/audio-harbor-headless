import type { RackApi } from '../../api/rackApi';
import type { RackInsert, RackSnapshot } from '../../api/types';
import { errorMessage } from '../../core/errors';
import { escapeAttr, escapeHtml } from '../../core/html';
import { icons } from '../icons';
import { showToast } from '../overlay';

/** What leaves the rack, amber while plugins shape the sound, and what that means. */
export function rackPathHtml(rack: RackSnapshot): string {
  const latency = rack.latencyMs ? ` · ${rack.latencyMs} ms` : '';
  return `
    <div class="rack-path">
      <span class="rack-path-label ${rack.path.lit ? 'is-lit' : ''}">${escapeHtml(rack.path.label)}${escapeHtml(latency)}</span>
      <p class="rack-path-note">${escapeHtml(rack.error ?? rack.path.note)}</p>
    </div>
  `;
}

/** One insert: its power key (lit = in circuit), name, and why it is not running. */
export function insertHeadHtml(insert: RackInsert, index: number): string {
  const on = !insert.bypassed;
  const sub = insert.error ?? (insert.loaded ? insert.vendor : `${insert.vendor} · not loaded`);
  return `
    <button type="button" class="rack-power ${on ? 'is-on' : ''}" data-power="${escapeAttr(insert.id)}"
      aria-pressed="${on}" aria-label="${escapeAttr(`${insert.name}: ${on ? 'in circuit' : 'bypassed'}`)}">${icons.power}</button>
    <span class="rack-slot">${index + 1}</span>
    <span class="rack-insert-text">
      <span class="rack-insert-name">${escapeHtml(insert.name)}</span>
      <span class="rack-insert-sub ${insert.error ? 'is-error' : ''}">${escapeHtml(sub)}</span>
    </span>
  `;
}

/** Power keys under `root` switch their insert in or out. */
export function bindPowerKeys(root: HTMLElement, rack: RackApi, current: () => RackSnapshot | null): void {
  root.querySelectorAll<HTMLButtonElement>('[data-power]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.dataset.power ?? '';
      const insert = current()?.inserts.find((i) => i.id === id);
      if (!insert) return;
      try {
        await rack.setInsertBypass(id, !insert.bypassed);
      } catch (err) {
        showToast(errorMessage(err, 'Could not switch the plugin'), { error: true });
      }
    });
  });
}
