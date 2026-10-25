import type { RackApi } from '../../api/rackApi';
import type { RackSnapshot } from '../../api/types';
import { errorMessage } from '../../core/errors';
import { escapeAttr, escapeHtml } from '../../core/html';
import { openActionMenu, openConfirmDialog, openNameDialog, showToast } from '../overlay';

/**
 * Rack presets — the whole rack under a name, "Headphones", "Speakers": chips to load one,
 * and on the full version the active one's Edited / Save and a menu to save, rename, delete.
 */
export function presetChipsHtml(rack: RackSnapshot, opts: { manage: boolean }): string {
  if (!rack.presets.length && !opts.manage) return '';
  const chips = rack.presets
    .map((p) => {
      const active = p.id === rack.activePreset;
      return `<button type="button" class="deck-pill preset-chip ${active ? 'is-on' : ''}" data-preset="${escapeAttr(p.id)}"
        title="${escapeAttr(p.plugins.join(' → '))}" aria-pressed="${active}">${escapeHtml(p.name)}${active && rack.edited ? ' •' : ''}</button>`;
    })
    .join('');
  const active = rack.presets.find((p) => p.id === rack.activePreset);
  const edited =
    opts.manage && active && rack.edited
      ? `<span class="preset-edited">Edited <button type="button" class="btn-text" data-preset-save>Save</button></span>`
      : '';
  const menu = opts.manage ? `<button type="button" class="deck-pill" data-preset-menu aria-label="Preset actions">•••</button>` : '';
  const empty = !rack.presets.length && opts.manage ? '<span class="preset-empty">No presets yet</span>' : '';
  return `<div class="preset-bar">${chips}${empty}${menu}</div>${edited}`;
}

export function bindPresetChips(root: HTMLElement, api: RackApi, current: () => RackSnapshot | null, apply: (s: RackSnapshot) => void): void {
  const run = async (change: () => Promise<RackSnapshot>, failure: string) => {
    try {
      apply(await change());
    } catch (err) {
      showToast(errorMessage(err, failure), { error: true });
    }
  };
  root.querySelectorAll<HTMLElement>('[data-preset]').forEach((chip) =>
    chip.addEventListener('click', () => void run(() => api.loadPreset(chip.dataset.preset ?? ''), 'Could not load the preset'))
  );
  root.querySelector('[data-preset-save]')?.addEventListener('click', () => {
    const id = current()?.activePreset;
    if (id) void run(() => api.overwritePreset(id), 'Could not save the preset');
  });
  root.querySelector('[data-preset-menu]')?.addEventListener('click', () => openPresetMenu(api, current, run));
}

function openPresetMenu(
  api: RackApi,
  current: () => RackSnapshot | null,
  run: (change: () => Promise<RackSnapshot>, failure: string) => Promise<void>
): void {
  const rack = current();
  if (!rack) return;
  const active = rack.presets.find((p) => p.id === rack.activePreset);
  openActionMenu({
    title: 'Rack Presets',
    subtitle: active ? `Loaded: ${active.name}${rack.edited ? ' (edited)' : ''}` : 'The whole rack under a name',
    groups: [
      [
        {
          label: 'Save as New Preset…',
          disabled: !rack.inserts.length,
          run: () =>
            openNameDialog({
              title: 'New Preset',
              placeholder: 'Headphones, Speakers…',
              confirmLabel: 'Save',
              onConfirm: (name) => run(() => api.savePreset(name), 'Could not save the preset'),
            }),
        },
        ...(active
          ? [
              {
                label: `Rename “${active.name}”…`,
                run: () =>
                  openNameDialog({
                    title: 'Rename Preset',
                    initial: active.name,
                    confirmLabel: 'Rename',
                    onConfirm: (name) => run(() => api.renamePreset(active.id, name), 'Could not rename the preset'),
                  }),
              },
            ]
          : []),
      ],
      active
        ? [
            {
              label: `Delete “${active.name}”…`,
              danger: true,
              run: () =>
                openConfirmDialog({
                  title: `Delete ${active.name}?`,
                  message: 'The rack stays as it is; only the preset goes.',
                  confirmLabel: 'Delete',
                  onConfirm: () => run(() => api.deletePreset(active.id), 'Could not delete the preset'),
                }),
            },
          ]
        : [],
    ],
  });
}
