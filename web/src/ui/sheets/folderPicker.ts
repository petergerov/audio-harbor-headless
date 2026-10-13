import type { SettingsApi } from '../../api/settingsApi';
import type { FolderListing } from '../../api/types';
import { errorMessage } from '../../core/errors';
import { escapeAttr, escapeHtml } from '../../core/html';
import { icons } from '../icons';
import { openPanel, showToast } from '../overlay';

/**
 * Walk the host's folders and pick one — no paths to type. Starts at `start`, or at the
 * places music usually is (drives under /mnt/harbor, /media, home).
 */
export function openFolderPicker(opts: {
  api: SettingsApi;
  start?: string;
  onPick: (path: string) => Promise<void>;
}): void {
  let current: FolderListing | null = null;
  let body: HTMLElement | null = null;
  let close = () => {};

  const paint = () => {
    if (!body || !current) return;
    const rows = current.folders
      .map(
        (f) => `
        <button type="button" class="cell" data-path="${escapeAttr(f.path)}">
          <span class="row-text"><span class="row-title">${escapeHtml(f.name)}</span>${
            current?.path === null ? `<span class="row-sub">${escapeHtml(f.path)}</span>` : ''
          }</span>
          <span class="chevron">${icons.chevron}</span>
        </button>`
      )
      .join('');
    const up =
      current.path !== null
        ? `<button type="button" class="cell" data-up><span class="row-text"><span class="row-title">‹ ${
            current.parent ? 'Up' : 'Start'
          }</span></span></button>`
        : '';
    body.innerHTML = `
      <p class="folder-path">${escapeHtml(current.path ?? 'Choose where your music is')}</p>
      <div class="group folder-group">
        ${up}
        ${rows || `<div class="empty compact"><strong>No Folders</strong>${current.path ? 'Add this one, or go up.' : ''}</div>`}
      </div>
    `;
    body.querySelector('[data-up]')?.addEventListener('click', () => void go(current?.parent ?? undefined));
    body.querySelectorAll<HTMLElement>('[data-path]').forEach((row) =>
      row.addEventListener('click', () => void go(row.dataset.path))
    );
  };

  const go = async (path?: string) => {
    try {
      current = await opts.api.folders(path);
    } catch (err) {
      showToast(errorMessage(err, 'Folder not readable'), { error: true });
      if (current) return;
      current = await opts.api.folders();
    }
    paint();
    body?.closest('.ah-panel-inner')?.scrollTo({ top: 0 });
  };

  openPanel({
    title: 'Choose Folder',
    primaryLabel: 'Add',
    bodyHtml: `<div data-folder-body></div>`,
    onPrimary: async () => {
      if (!current?.path) throw new Error('Open the folder with your music first');
      await opts.onPick(current.path);
      close();
    },
    bind: (root, closePanel) => {
      close = closePanel;
      body = root.querySelector('[data-folder-body]');
      void go(opts.start);
    },
  });
}
