import type { SettingsApi } from '../../../api/settingsApi';
import { errorMessage } from '../../../core/errors';
import { escapeHtml, required } from '../../../core/html';
import type { Store } from '../../../core/store';
import type { AppState } from '../../../state/appState';
import { showToast } from '../../overlay';
import type { Pane } from '../settingsView';

const DONE_MS = 1200;

/** The music folders on the host: list, add, remove, rescan. */
export class SourcesPane implements Pane {
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly settings: SettingsApi,
    private readonly store: Store<AppState>
  ) {}

  async render(root: HTMLElement): Promise<void> {
    this.dispose();
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

    const rescan = required<HTMLButtonElement>(root, '[data-rescan]');
    const value = required(rescan, '.value');
    let done = false;
    // A scan may also come from the iOS app (Rebuild Index), a new folder or the host's start.
    const paint = () => {
      const scanning = Boolean(this.store.get().settings?.isScanning);
      rescan.disabled = scanning;
      if (!done) value.textContent = scanning ? 'Rescanning…' : 'Rescan';
    };
    this.unsubscribe = this.store.subscribe((state, previous) => {
      if (state.settings !== previous.settings) paint();
    });
    paint();
    rescan.addEventListener('click', async () => {
      rescan.disabled = true;
      value.textContent = 'Rescanning…';
      try {
        await this.settings.rescan();
      } catch (err) {
        showToast(errorMessage(err, 'Could not update the library'), { error: true });
        paint();
        return;
      }
      done = true;
      value.textContent = 'Done';
      window.setTimeout(() => {
        done = false;
        paint();
      }, DONE_MS);
    });
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
