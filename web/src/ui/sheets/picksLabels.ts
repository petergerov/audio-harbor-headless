import type { LabelChoice } from '../../api/types';
import { haptic } from '../../core/device';
import { errorMessage } from '../../core/errors';
import { songs } from '../../core/format';
import { escapeAttr, escapeHtml, required } from '../../core/html';
import { closeOverlay, openPanel, showToast } from '../overlay';
import type { SheetDeps } from './sheetDeps';

const MARKS: Record<LabelChoice['coverage'], string> = { none: '', some: '–', all: '✓' };
const SPOKEN: Record<LabelChoice['coverage'], string> = {
  none: 'None of them',
  some: 'Some of them',
  all: 'All of them',
};

/**
 * Labels for the ticked songs (the Mac app 1.1.8's remote): every label, ticked when all of them
 * carry it and half-ticked when some do. Tap one to put it on all of them, a ticked one to take
 * it off all of them, or name a new one. The host answers each change, so the marks follow.
 */
export async function openPicksLabels(paths: string[], deps: SheetDeps): Promise<void> {
  if (!paths.length) return;
  let choices: LabelChoice[];
  try {
    choices = await deps.collections.labelChoices(paths);
  } catch (err) {
    showToast(errorMessage(err, 'Could not load the labels'), { error: true });
    return;
  }
  // Set once the panel is up.
  let repaint = () => {};

  const rows = () =>
    choices
      .map(
        (label) => `
        <button type="button" class="picker-row label-choice" data-label="${escapeAttr(label.name)}"
          aria-label="${escapeAttr(label.name)}" aria-description="${SPOKEN[label.coverage]}">
          <span class="row-tick${label.coverage === 'none' ? '' : ' on'}" aria-hidden="true">${MARKS[label.coverage]}</span>
          <span class="picker-text"><strong>${escapeHtml(label.name)}</strong></span>
          ${label.coverage === 'some' ? '<span class="label-some">some</span>' : ''}
        </button>`
      )
      .join('') || `<p class="picker-empty">No labels yet. Type one above.</p>`;

  openPanel({
    title: 'Labels',
    subtitle: `${songs(paths.length)} selected`,
    primaryLabel: 'Done',
    onPrimary: async () => {
      const pending = document.querySelector<HTMLInputElement>('#picksLabelInput')?.value.trim() ?? '';
      if (pending) await apply(pending, 'add');
      closeOverlay();
    },
    bodyHtml: `
      <form class="ah-form label-add-form" id="picksLabelForm">
        <input class="ah-input" id="picksLabelInput" type="text" placeholder="New label" enterkeyhint="done"
          autocomplete="off" aria-label="New label" />
        <button type="submit" class="ah-add-btn">Add</button>
      </form>
      <div class="ah-group picker-list" id="picksLabelList">${rows()}</div>
      <p class="picker-note">Tap a label to put it on all of them. Tap a ticked label to take it off all of them.</p>
    `,
    bind: (root) => {
      const list = required(root, '#picksLabelList');
      const input = required<HTMLInputElement>(root, '#picksLabelInput');
      const bindRows = () =>
        list.querySelectorAll<HTMLElement>('[data-label]').forEach((row) => {
          row.addEventListener('click', () => {
            const label = choices.find((c) => c.name === row.dataset.label);
            if (label) void apply(label.name, label.coverage === 'all' ? 'remove' : 'add');
          });
        });
      repaint = () => {
        list.innerHTML = rows();
        bindRows();
      };
      root.querySelector('#picksLabelForm')?.addEventListener('submit', (event) => {
        event.preventDefault();
        const name = input.value.trim();
        if (!name) return;
        input.value = '';
        void apply(name, 'add');
      });
      bindRows();
    },
  });

  async function apply(name: string, change: 'add' | 'remove'): Promise<void> {
    try {
      if (change === 'add') await deps.collections.addLabelToPaths(name, paths);
      else await deps.collections.removeLabelFromPaths(name, paths);
      haptic('light');
      choices = await deps.collections.labelChoices(paths);
      repaint();
      // Each change is made at once: the sidebar and the rows' labels follow, whatever closes the sheet.
      void deps.nav.refresh();
    } catch (err) {
      showToast(errorMessage(err, 'Could not change the label'), { error: true });
    }
  }
}
