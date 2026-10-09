import type { Selection } from '../../api/types';
import { haptic } from '../../core/device';
import { errorMessage } from '../../core/errors';
import { escapeAttr, escapeHtml, required } from '../../core/html';
import { closeOverlay, openPanel, showToast } from '../overlay';
import type { SheetDeps } from './sheetDeps';

const byName = (a: string, b: string) => a.localeCompare(b);

/** Labels on a track, album, artist or folder: add, remove, or pick one already in use. */
export async function openLabelEditor(selection: Selection, deps: SheetDeps): Promise<void> {
  if (!(selection.cataloguePath || selection.albumId || selection.artist || selection.folder)) {
    showToast('Cannot label this item', { error: true });
    return;
  }
  await deps.collections.refresh();
  let current: string[] = [];
  if (selection.cataloguePath) {
    current = await deps.collections.trackLabels(selection.cataloguePath).catch(() => []);
  }
  let known = [...new Set([...deps.store.get().collections.labels.map((l) => l.name), ...current])].sort(byName);

  const chips = () =>
    current
      .map(
        (n) =>
          `<button type="button" class="chip on" data-remove="${escapeAttr(n)}">${escapeHtml(n)} <span aria-hidden="true">×</span></button>`
      )
      .join('') || `<span class="picker-empty">No labels on this item yet.</span>`;
  const suggestions = () =>
    known
      .filter((n) => !current.includes(n))
      .map((n) => `<button type="button" class="chip" data-add="${escapeAttr(n)}">${escapeHtml(n)}</button>`)
      .join('') || `<span class="picker-empty">Type a new label above.</span>`;

  let add: (name: string) => Promise<boolean> = async () => false;

  openPanel({
    title: 'Labels',
    subtitle: selection.title,
    primaryLabel: 'Done',
    // A label typed but not added yet is added on Done.
    onPrimary: async () => {
      const pending = document.querySelector<HTMLInputElement>('#labelInput')?.value.trim() ?? '';
      if (pending && !(await add(pending))) return;
      closeOverlay();
    },
    bodyHtml: `
      <form class="ah-form label-add-form" id="labelForm">
        <input class="ah-input" id="labelInput" type="text" placeholder="New label" enterkeyhint="done" autocomplete="off" aria-label="New label" />
        <button type="submit" class="ah-add-btn">Add</button>
      </form>
      <p class="ah-section">On This Item</p>
      <div class="chip-row" id="currentChips">${chips()}</div>
      <p class="ah-section">Suggestions</p>
      <div class="chip-row" id="knownChips">${suggestions()}</div>
    `,
    bind: (root) => {
      const input = required<HTMLInputElement>(root, '#labelInput');
      const repaint = () => {
        required(root, '#currentChips').innerHTML = chips();
        required(root, '#knownChips').innerHTML = suggestions();
        bindChips();
      };
      add = async (name) => {
        const label = name.trim();
        if (!label) {
          input.focus();
          return false;
        }
        try {
          await deps.collections.addLabel(label, selection);
        } catch (err) {
          showToast(errorMessage(err, 'Could not add label'), { error: true });
          return false;
        }
        if (!current.includes(label)) current.push(label);
        if (!known.includes(label)) known = [...known, label].sort(byName);
        input.value = '';
        showToast(`Labeled “${label}”`);
        haptic();
        await deps.collections.refresh();
        repaint();
        return true;
      };
      const remove = async (label: string) => {
        try {
          await deps.collections.removeLabel(label, selection);
        } catch (err) {
          showToast(errorMessage(err, 'Could not remove label'), { error: true });
          return;
        }
        current = current.filter((n) => n !== label);
        showToast('Label removed');
        await deps.collections.refresh();
        repaint();
      };
      const bindChips = () => {
        root.querySelectorAll<HTMLElement>('[data-add]').forEach((chip) => {
          chip.addEventListener('click', () => void add(chip.dataset.add ?? ''));
        });
        root.querySelectorAll<HTMLElement>('[data-remove]').forEach((chip) => {
          chip.addEventListener('click', () => void remove(chip.dataset.remove ?? ''));
        });
      };
      root.querySelector('#labelForm')?.addEventListener('submit', (event) => {
        event.preventDefault();
        void add(input.value);
      });
      bindChips();
      queueMicrotask(() => input.focus());
    },
  });
}
