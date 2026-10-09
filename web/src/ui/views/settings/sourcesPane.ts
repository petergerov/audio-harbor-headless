import type { SettingsApi } from '../../../api/settingsApi';
import { errorMessage } from '../../../core/errors';
import { escapeHtml, required } from '../../../core/html';
import { showToast } from '../../overlay';
import type { Pane } from '../settingsView';

const DONE_MS = 1200;

/** The music folders on the host: list, add, remove, rescan. */
export class SourcesPane implements Pane {
  constructor(private readonly settings: SettingsApi) {}

  async render(root: HTMLElement): Promise<void> {
    const mounts = await this.settings.mounts();
    root.innerHTML = `
      <p class="group-label">On This Host</p>
      <div class="group" data-mounts></div>
      <p class="group-label">Add Folder</p>
      <div class="group">
        <form data-add-mount class="cell form-cell">
          <input name="path" type="text" placeholder="/path/to/music" required autocomplete="off"
            autocapitalize="off" spellcheck="false" aria-label="Folder path" />
          <button class="btn-text" type="submit">Add</button>
        </form>
      </div>
      <div class="group">
        <button type="button" class="cell" data-rescan><span>Update Library</span><span class="value">Rescan</span></button>
      </div>
      <p class="footer-note">Paths must exist on the host running Harbor.</p>
    `;

    const list = required(root, '[data-mounts]');
    if (!mounts.length) {
      list.innerHTML = `<div class="empty compact"><strong>No Folders</strong>Add a music directory to get started.</div>`;
    }
    for (const mount of mounts) {
      const row = document.createElement('div');
      row.className = 'cell';
      row.innerHTML = `
        <div class="row-text">
          <div class="row-title">${escapeHtml(mount.displayName)}</div>
          <div class="row-sub">${escapeHtml(mount.path)}</div>
        </div>
        <button type="button" class="btn-text danger">Remove</button>
      `;
      required(row, 'button').addEventListener('click', async () => {
        await this.settings.removeMount(mount.path);
        await this.render(root);
      });
      list.appendChild(row);
    }

    required<HTMLFormElement>(root, '[data-add-mount]').addEventListener('submit', async (event) => {
      event.preventDefault();
      const path = String(new FormData(event.target as HTMLFormElement).get('path'));
      try {
        await this.settings.addMount(path);
        await this.render(root);
      } catch (err) {
        showToast(errorMessage(err, 'Could not add folder'), { error: true });
      }
    });

    const rescan = required(root, '[data-rescan]');
    rescan.addEventListener('click', async () => {
      await this.settings.rescan();
      const value = rescan.querySelector('.value');
      if (!value) return;
      value.textContent = 'Done';
      window.setTimeout(() => {
        value.textContent = 'Rescan';
      }, DONE_MS);
    });
  }
}
