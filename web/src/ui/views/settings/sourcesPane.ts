import type { SettingsApi } from '../../../api/settingsApi';
import type { Drive, DriveList } from '../../../api/types';
import { errorMessage } from '../../../core/errors';
import { escapeHtml, required } from '../../../core/html';
import type { Store } from '../../../core/store';
import type { AppState } from '../../../state/appState';
import { openActionMenu, openConfirmDialog, openNameDialog, showToast } from '../../overlay';
import { openFolderPicker } from '../../sheets/folderPicker';
import type { Pane } from '../settingsView';

const DONE_MS = 1200;

function formatSize(bytes: number | null): string {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function driveSubtitle(drive: Drive): string {
  const facts = [formatSize(drive.sizeBytes), drive.fsType].filter(Boolean).join(' ');
  if (!drive.name) return [facts, drive.device].filter(Boolean).join(' · ');
  if (!drive.connected) return `Not connected · ${drive.mountPoint}`;
  return [drive.mountPoint, facts].filter(Boolean).join(' · ');
}

/** The music folders on the host: list, add, remove, rescan — and drives to set up for them. */
export class SourcesPane implements Pane {
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly settings: SettingsApi,
    private readonly store: Store<AppState>
  ) {}

  async render(root: HTMLElement): Promise<void> {
    this.dispose();
    const [mounts, drives] = await Promise.all([
      this.settings.mounts(),
      this.settings.drives().catch((): DriveList => ({ supported: false, reason: null, drives: [] })),
    ]);
    const showDrives = drives.supported || Boolean(drives.reason);
    root.innerHTML = `
      <p class="group-label">On This Host</p>
      <div class="group" data-mounts></div>
      <div ${showDrives ? '' : 'hidden'}>
        <p class="group-label">Drives</p>
        <div class="group" data-drives></div>
        <p class="footer-note" data-drives-note></p>
      </div>
      <p class="group-label">Add Folder</p>
      <div class="group">
        <button type="button" class="cell cell-action" data-choose>Choose Folder…</button>
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

    this.renderDrives(root, drives);
    required(root, '[data-choose]').addEventListener('click', () => this.chooseFolder(root));

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

  private chooseFolder(root: HTMLElement, start?: string): void {
    openFolderPicker({
      api: this.settings,
      start,
      onPick: async (path) => {
        await this.settings.addMount(path);
        showToast('Added — the library is updating');
        await this.render(root);
      },
    });
  }

  private renderDrives(root: HTMLElement, list: DriveList): void {
    const group = required(root, '[data-drives]');
    const note = required(root, '[data-drives-note]');
    if (!list.supported) {
      group.hidden = true;
      note.textContent = list.reason ?? '';
      return;
    }
    note.textContent = 'Set up mounts a drive read-only under /mnt/harbor and keeps it in /etc/fstab — after unplugging it comes back on its own.';
    group.innerHTML = list.drives.length
      ? ''
      : `<div class="empty compact"><strong>No Drives</strong>Plug in a USB drive, then look again.</div>`;

    for (const drive of list.drives) {
      const row = document.createElement('div');
      row.className = 'cell';
      const actions = !drive.name
        ? `<button type="button" class="btn-text" data-setup>Set Up</button>`
        : `${drive.connected ? `<button type="button" class="btn-text" data-choose-on>Add Folder</button>` : ''}
           <button type="button" class="btn-text" data-more aria-label="More">•••</button>`;
      row.innerHTML = `
        <div class="row-text">
          <div class="row-title">${escapeHtml(drive.name ?? drive.title)}</div>
          <div class="row-sub">${escapeHtml(driveSubtitle(drive))}</div>
        </div>
        ${actions}
      `;
      row.querySelector('[data-setup]')?.addEventListener('click', () => this.setUpDrive(root, drive));
      row
        .querySelector('[data-choose-on]')
        ?.addEventListener('click', () => this.chooseFolder(root, drive.mountPoint ?? undefined));
      row.querySelector('[data-more]')?.addEventListener('click', () => this.driveMenu(root, drive));
      group.appendChild(row);
    }

    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'cell cell-action';
    refresh.textContent = 'Look for Drives';
    refresh.addEventListener('click', () => void this.render(root));
    group.appendChild(refresh);
  }

  private setUpDrive(root: HTMLElement, drive: Drive): void {
    openNameDialog({
      title: `Set Up ${drive.title}`,
      placeholder: 'Name (letters, digits, - _ .)',
      initial: drive.suggestedName,
      confirmLabel: 'Set Up',
      onConfirm: async (name) => {
        const mountPoint = await this.settings.setUpDrive(drive.uuid, name);
        await this.render(root);
        // Straight on to the music folder on it.
        queueMicrotask(() => this.chooseFolder(root, mountPoint));
      },
    });
  }

  private driveMenu(root: HTMLElement, drive: Drive): void {
    const name = drive.name;
    if (!name) return;
    const remove = () =>
      openConfirmDialog({
        title: `Remove ${name}?`,
        message: `Takes ${drive.mountPoint} out of /etc/fstab and its folders out of the library. The files on the drive stay.`,
        confirmLabel: 'Remove Drive',
        onConfirm: async () => {
          await this.settings.removeDrive(name);
          await this.render(root);
        },
      });
    openActionMenu({
      title: name,
      subtitle: driveSubtitle(drive),
      groups: [
        drive.mounted
          ? [
              {
                label: 'Eject',
                run: async () => {
                  await this.settings.ejectDrive(name);
                  showToast(`${name} can be unplugged`);
                  await this.render(root);
                },
              },
            ]
          : [],
        [{ label: 'Remove Drive…', danger: true, run: () => queueMicrotask(remove) }],
      ],
    });
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
