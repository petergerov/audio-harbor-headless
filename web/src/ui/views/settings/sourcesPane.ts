import type { SettingsApi } from '../../../api/settingsApi';
import type { Drive, DriveList, ScanProgress } from '../../../api/types';
import { errorMessage } from '../../../core/errors';
import { escapeHtml, required } from '../../../core/html';
import type { Store } from '../../../core/store';
import type { AppState } from '../../../state/appState';
import { openActionMenu, openConfirmDialog, openNameDialog, showToast } from '../../overlay';
import { icons } from '../../icons';
import { openFolderPicker } from '../../sheets/folderPicker';
import { openShareDialog } from '../../sheets/shareSheet';
import type { Pane } from '../settingsView';

const count = (n: number) => n.toLocaleString();

/** One line on where the scan is, or how the last one went. */
function scanText(scan: ScanProgress | null): string {
  if (!scan) return '';
  const where = scan.root ? ` · ${scan.root.split('/').filter(Boolean).pop() ?? scan.root}` : '';
  switch (scan.phase) {
    case 'listing':
      return `Looking for music… ${count(scan.total)} files${where}`;
    case 'reading':
      return `Reading ${count(scan.done)} of ${count(scan.total)} · ${count(scan.indexed)} new or changed${where}`;
    case 'finishing':
      return 'Updating the search index…';
    default:
      if (!scan.lastScan) return '';
      return `Last scan ${new Date(scan.lastScan.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${count(scan.lastScan.scanned)} files, ${count(scan.lastScan.indexed)} new or changed`;
  }
}

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
  if (drive.kind === 'share') return `${drive.title} · ${drive.mounted ? 'mounted' : 'mounts on access'}`;
  const facts = [formatSize(drive.sizeBytes), drive.fsType].filter(Boolean).join(' ');
  if (!drive.name) return [facts, drive.device].filter(Boolean).join(' · ');
  if (!drive.connected) return `Not connected · ${drive.mountPoint}`;
  return [drive.mountPoint, facts].filter(Boolean).join(' · ');
}

/** The music folders on the host: list, add, remove, rescan — and drives to set up for them. */
export class SourcesPane implements Pane {
  private unsubscribe: (() => void) | null = null;
  /** A folder was added since the last scan — its music comes with Rescan. */
  private pending = false;
  private addedAt = 0;

  constructor(
    private readonly settings: SettingsApi,
    private readonly store: Store<AppState>
  ) {}

  async render(root: HTMLElement): Promise<void> {
    this.dispose();
    const [mounts, drives] = await Promise.all([
      this.settings.mounts(),
      this.settings.drives().catch((): DriveList => ({ supported: false, reason: null, drives: [] })),
      this.settings
        .scanProgress()
        .then((scan) => this.store.update({ scan }))
        .catch(() => {}),
    ]);
    const showDrives = drives.supported || Boolean(drives.reason);
    // Something to scan: a library folder, or a drive / share that is set up.
    const showUpdate = mounts.length > 0 || drives.drives.some((d) => d.name);
    root.innerHTML = `
      <div ${showUpdate ? '' : 'hidden'}>
        <p class="group-label">Library</p>
        <div class="group">
          <button type="button" class="cell" data-rescan>
            <span>Update Library</span>
            <span class="value rescan-value"><span class="rescan-icon">${icons.rescan}</span><span data-rescan-label>Rescan</span></span>
          </button>
          <div class="cell scan-status" data-scan-status hidden>
            <div class="row-text">
              <div class="row-sub" data-scan-text></div>
              <div class="scan-bar" data-scan-bar hidden><span></span></div>
            </div>
          </div>
        </div>
      </div>
      <p class="group-label">On This Host</p>
      <div class="group" data-mounts></div>
      <div ${showDrives ? '' : 'hidden'}>
        <p class="group-label">Drives &amp; Network Shares</p>
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
        this.markPending();
        await this.render(root);
      } catch (err) {
        showToast(errorMessage(err, 'Could not add folder'), { error: true });
      }
    });

    const rescan = required<HTMLButtonElement>(root, '[data-rescan]');
    const value = required(rescan, '.value');
    const label = required(rescan, '[data-rescan-label]');
    const status = required(root, '[data-scan-status]');
    const text = required(root, '[data-scan-text]');
    const bar = required(root, '[data-scan-bar]');
    const fill = required(bar, 'span');
    // A scan may also come from the iOS app (Rebuild Index), another remote or the host's start.
    const paint = () => {
      const scan = this.store.get().scan;
      const scanning = Boolean(scan?.scanning);
      if (!scanning && scan?.lastScan && this.pending && scan.lastScan.at > this.addedAt) this.pending = false;
      rescan.disabled = scanning;
      label.textContent = scanning ? 'Scanning…' : this.pending ? 'Rescan Now' : 'Rescan';
      value.classList.toggle('accent', !scanning && this.pending);
      value.classList.toggle('spinning', scanning);
      const line = this.pending && !scanning ? 'New folders are read when you press Rescan.' : scanText(scan);
      text.textContent = line;
      status.hidden = !line;
      bar.hidden = !scanning || !scan?.total || scan.phase !== 'reading';
      fill.style.width = scan?.total ? `${Math.min(100, (scan.done / scan.total) * 100)}%` : '0';
    };
    this.unsubscribe = this.store.subscribe((state, previous) => {
      if (state.scan !== previous.scan) paint();
    });
    paint();
    rescan.addEventListener('click', async () => {
      rescan.disabled = true;
      label.textContent = 'Scanning…';
      value.classList.add('spinning');
      try {
        this.store.update({ scan: await this.settings.rescan() });
      } catch (err) {
        showToast(errorMessage(err, 'Could not update the library'), { error: true });
        paint();
      }
    });
  }

  /** After a folder is added: no scan yet, Rescan reads it. */
  private markPending(): void {
    this.pending = true;
    this.addedAt = Date.now();
  }

  private chooseFolder(root: HTMLElement, start?: string): void {
    openFolderPicker({
      api: this.settings,
      start,
      onPick: async (path) => {
        await this.settings.addMount(path);
        this.markPending();
        showToast('Added — press Rescan to read its music');
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
    note.textContent =
      'Set up mounts a drive or share read-only under /mnt/harbor and keeps it in /etc/fstab — after unplugging or a restart it comes back on its own.';
    group.innerHTML = list.drives.length
      ? ''
      : `<div class="empty compact"><strong>No Drives</strong>Plug in a USB drive and look again, or add a network share.</div>`;

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

    const addShare = document.createElement('button');
    addShare.type = 'button';
    addShare.className = 'cell cell-action';
    addShare.textContent = 'Add Network Share…';
    addShare.addEventListener('click', () => this.addShare(root));
    group.appendChild(addShare);
  }

  private addShare(root: HTMLElement): void {
    openShareDialog({
      onConfirm: async (form) => {
        const mountPoint = await this.settings.setUpShare(form);
        await this.render(root);
        // Straight on to the music folder on it, as for a drive (after the form has closed).
        window.setTimeout(() => this.chooseFolder(root, mountPoint), 0);
      },
    });
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
        // Straight on to the music folder on it — after this dialog has closed, or closing it
        // would take the picker with it.
        window.setTimeout(() => this.chooseFolder(root, mountPoint), 0);
      },
    });
  }

  private driveMenu(root: HTMLElement, drive: Drive): void {
    const name = drive.name;
    if (!name) return;
    const share = drive.kind === 'share';
    const remove = () =>
      openConfirmDialog({
        title: `Remove ${name}?`,
        message: share
          ? `Takes ${drive.title} out of /etc/fstab, deletes its stored login and takes its folders out of the library. The files on the server stay.`
          : `Takes ${drive.mountPoint} out of /etc/fstab and its folders out of the library. The files on the drive stay.`,
        confirmLabel: share ? 'Remove Share' : 'Remove Drive',
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
                label: share ? 'Unmount' : 'Eject',
                run: async () => {
                  await this.settings.ejectDrive(name);
                  showToast(share ? `${name} unmounted — it mounts again on access` : `${name} can be unplugged`);
                  await this.render(root);
                },
              },
            ]
          : [],
        [{ label: share ? 'Remove Share…' : 'Remove Drive…', danger: true, run: () => queueMicrotask(remove) }],
      ],
    });
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
