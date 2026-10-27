import type { RackApi } from '../../../api/rackApi';
import type { RackSnapshot } from '../../../api/types';
import { errorMessage } from '../../../core/errors';
import { escapeAttr, escapeHtml, required } from '../../../core/html';
import type { Store } from '../../../core/store';
import type { AppState } from '../../../state/appState';
import { bindPowerKeys, insertHeadHtml, rackPathHtml } from '../../components/rackControls';
import { openActionMenu, openConfirmDialog, showToast } from '../../overlay';
import { openInsertSheet } from '../../rack/insertSheet';
import { bindPresetChips, presetChipsHtml } from '../../rack/presets';
import { openPluginPicker } from '../../sheets/rackPlugins';
import type { Pane } from '../settingsView';

/**
 * The plugin rack: what is in it and in what order, each insert's switch and parameters,
 * adding and removing plugins, and the whole-rack A/B. Follows the host while open.
 */
export class RackPane implements Pane {
  private unsubscribe: (() => void) | null = null;
  private root: HTMLElement | null = null;

  constructor(
    private readonly store: Store<AppState>,
    private readonly rack: RackApi
  ) {}

  async render(root: HTMLElement): Promise<void> {
    this.dispose();
    this.root = root;
    let snapshot = this.store.get().rack;
    if (!snapshot) {
      try {
        snapshot = await this.rack.rack();
        this.store.update({ rack: snapshot });
      } catch (err) {
        root.innerHTML = `<p class="footer-note">${escapeHtml(errorMessage(err, 'Could not load the rack'))}</p>`;
        return;
      }
    }
    this.paint(snapshot);
    this.unsubscribe = this.store.subscribe((state, previous) => {
      if (state.rack && state.rack !== previous.rack) this.paint(state.rack);
    });
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.root = null;
  }

  private paint(rack: RackSnapshot): void {
    const root = this.root;
    if (!root) return;
    if (!rack.available) {
      root.innerHTML = `
        <p class="group-label">Plugin Rack</p>
        <div class="group"><div class="cell"><span>Not available on this host</span></div></div>
        <p class="footer-note">The rack runs CLAP plugins (and LV2 on Linux) in harbor-fx, next to the engine. This build has no harbor-fx, or runs on Windows, where the rack comes later.</p>
      `;
      return;
    }
    const inserts = rack.inserts
      .map(
        (insert, index) => `
        <div class="cell rack-cell">
          <div class="rack-insert-head">${insertHeadHtml(insert, index)}</div>
          <button type="button" class="btn-text" data-params="${escapeAttr(insert.id)}" ${insert.loaded ? '' : 'disabled'}>Open</button>
          <button type="button" class="btn-text" data-more="${escapeAttr(insert.id)}" aria-label="${escapeAttr(`More for ${insert.name}`)}">•••</button>
        </div>`
      )
      .join('');
    root.innerHTML = `
      <p class="group-label">Path</p>
      <div class="group rack-path-group">${rackPathHtml(rack)}</div>
      <div class="group">
        <label class="cell">
          <span>Bypass Rack (A/B)</span>
          <input type="checkbox" role="switch" class="switch" data-ab ${rack.bypassed ? 'checked' : ''} ${rack.inserts.length ? '' : 'disabled'} />
        </label>
      </div>
      <p class="group-label">Presets</p>
      <div class="group rack-presets">${presetChipsHtml(rack, { manage: true })}</div>
      <p class="group-label">Inserts · top to bottom</p>
      <div class="group">
        ${inserts}
        <button type="button" class="cell cell-action" data-add>Add Plugin…</button>
      </div>
      <p class="footer-note">Plugins run in their own process: one that crashes does not stop the music. A moving knob is heard within a moment. With plugins, DSD plays as PCM; only an empty rack is bit-perfect or plays DoP. Network players get the music through the plugins too.</p>
    `;
    bindPowerKeys(root, this.rack, () => this.store.get().rack);
    bindPresetChips(root, this.rack, () => this.store.get().rack, (snapshot) => this.store.update({ rack: snapshot }));
    required<HTMLInputElement>(root, '[data-ab]').addEventListener('change', (e) =>
      this.apply(() => this.rack.setBypass((e.target as HTMLInputElement).checked))
    );
    root.querySelector('[data-add]')?.addEventListener('click', () =>
      openPluginPicker(this.rack, (snapshot) => this.store.update({ rack: snapshot }))
    );
    root.querySelectorAll<HTMLButtonElement>('[data-params]').forEach((button) => {
      button.addEventListener('click', () => {
        const insert = this.store.get().rack?.inserts.find((i) => i.id === button.dataset.params);
        if (!insert) return;
        openInsertSheet(this.rack, insert, (snapshot) => this.store.update({ rack: snapshot }));
      });
    });
    root.querySelectorAll<HTMLButtonElement>('[data-more]').forEach((button) => {
      button.addEventListener('click', () => this.openMenu(button.dataset.more ?? ''));
    });
  }

  private openMenu(id: string): void {
    const rack = this.store.get().rack;
    const index = rack?.inserts.findIndex((i) => i.id === id) ?? -1;
    const insert = rack?.inserts[index];
    if (!rack || !insert) return;
    openActionMenu({
      title: insert.name,
      subtitle: insert.vendor,
      groups: [
        [
          {
            label: insert.bypassed ? 'Switch In' : 'Bypass',
            run: () => this.apply(() => this.rack.setInsertBypass(id, !insert.bypassed)),
          },
          { label: 'Move Up', disabled: index === 0, run: () => this.apply(() => this.rack.move(id, -1)) },
          {
            label: 'Move Down',
            disabled: index === rack.inserts.length - 1,
            run: () => this.apply(() => this.rack.move(id, 1)),
          },
        ],
        [
          {
            label: 'Remove from Rack',
            danger: true,
            run: () =>
              openConfirmDialog({
                title: `Remove ${insert.name}?`,
                message: 'Its settings go with it.',
                confirmLabel: 'Remove',
                onConfirm: () => this.apply(() => this.rack.remove(id)),
              }),
          },
        ],
      ],
    });
  }

  private async apply(change: () => Promise<RackSnapshot>): Promise<void> {
    try {
      this.store.update({ rack: await change() });
    } catch (err) {
      showToast(errorMessage(err, 'Could not change the rack'), { error: true });
    }
  }
}
