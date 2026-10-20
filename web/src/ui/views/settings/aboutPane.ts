import type { SettingsApi } from '../../../api/settingsApi';
import type { SystemStatus, UpdateStatus } from '../../../api/types';
import { errorMessage } from '../../../core/errors';
import { escapeHtml, required } from '../../../core/html';
import type { Store } from '../../../core/store';
import type { HostSettings } from '../../../services/settingsService';
import type { AppState } from '../../../state/appState';
import { openConfirmDialog, showToast } from '../../overlay';
import type { Pane } from '../settingsView';

/** How often the host's CPU / memory / disks refresh while About is open. */
const SYSTEM_REFRESH_MS = 3000;
/** How often an update in progress is asked about, and when it counts as stuck. */
const UPDATE_POLL_MS = 2000;
const UPDATE_GIVE_UP_MS = 15 * 60 * 1000;
const UPDATE_RUNNING: UpdateStatus['state'][] = ['starting', 'downloading', 'installing'];

function bytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function duration(secs: number): string {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}

/** A labelled value with a bar for how full it is. */
function meter(label: string, value: string, used: number, sub = ''): string {
  const pct = Math.max(0, Math.min(100, used * 100));
  const level = pct >= 90 ? ' high' : pct >= 75 ? ' warn' : '';
  return `
    <div class="cell meter-cell">
      <div class="row-text">
        <div class="meter-line"><span>${escapeHtml(label)}</span><span class="value">${escapeHtml(value)}</span></div>
        <div class="meter${level}"><span style="width:${pct.toFixed(1)}%"></span></div>
        ${sub ? `<div class="row-sub">${escapeHtml(sub)}</div>` : ''}
      </div>
    </div>`;
}

function systemHtml(s: SystemStatus): string {
  const temp = s.cpu.temperatureC !== null ? ` · ${s.cpu.temperatureC.toFixed(1)} °C` : '';
  const usedMem = s.memory.totalBytes - s.memory.availableBytes;
  const rows = [
    meter('CPU', `${s.cpu.usagePercent.toFixed(0)} %${temp}`, s.cpu.usagePercent / 100, `${s.cpu.cores} cores · ${s.cpu.model} · load ${s.cpu.load1}`),
    meter('Memory', `${bytes(usedMem)} of ${bytes(s.memory.totalBytes)}`, usedMem / s.memory.totalBytes, `Harbor uses ${bytes(s.memory.harborBytes)}`),
    ...s.disks.map((d) =>
      meter(
        d.mount,
        `${bytes(d.freeBytes)} free of ${bytes(d.totalBytes)}`,
        d.totalBytes ? 1 - d.freeBytes / d.totalBytes : 0,
        d.uses.join(', ')
      )
    ),
  ];
  return rows.join('');
}

/** The new build of the remote — the service worker answers from its cache first, so drop that. */
async function loadNewRemote(): Promise<void> {
  if ('caches' in window) {
    await caches
      .keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .catch(() => undefined);
  }
  location.reload();
}

/**
 * An update in progress, kept when Settings is left: asks the host until it answers with
 * another version, then loads the new remote. `paint` is the About pane while it is open;
 * it gets null while the host restarts.
 */
class UpdateWatch {
  private timer: number | null = null;
  paint: ((s: UpdateStatus | null) => void) | null = null;

  get active(): boolean {
    return this.timer !== null;
  }

  start(api: SettingsApi, from: string): void {
    if (this.timer !== null) return;
    const until = Date.now() + UPDATE_GIVE_UP_MS;
    const tick = async () => {
      let s: UpdateStatus | null = null;
      try {
        s = await api.update();
      } catch {
        /* restarting */
      }
      if (s && s.current !== from) {
        this.timer = null;
        showToast(`Updated to ${s.current}`);
        window.setTimeout(() => void loadNewRemote(), 1200);
        return;
      }
      if (s?.state === 'failed' || Date.now() > until) {
        this.timer = null;
        showToast(s?.state === 'failed' ? (s.message ?? 'The update failed') : 'The host did not come back', {
          error: true,
        });
      } else {
        this.timer = window.setTimeout(() => void tick(), UPDATE_POLL_MS);
      }
      this.paint?.(s);
    };
    this.timer = window.setTimeout(() => void tick(), UPDATE_POLL_MS);
  }
}

const updateWatch = new UpdateWatch();

/** The Software Update cells: the update in progress, or what there is to install. */
function updateHtml(s: UpdateStatus, restarting: boolean): string {
  const running = UPDATE_RUNNING.includes(s.state);
  if (restarting || updateWatch.active || running) {
    const target = (s.target ?? s.tag ?? '').replace(/^v/, '');
    // Installed, or the old host about to stop: what comes next is the restart.
    const step = restarting || !running ? 'Restarting Harbor…' : (s.message ?? 'Starting…');
    return `
      <div class="cell">
        <div class="row-text">
          <div class="row-title">Updating to ${escapeHtml(target)}</div>
          <div class="row-sub">${escapeHtml(step)}</div>
        </div>
      </div>`;
  }
  const check = `<button type="button" class="cell cell-action" data-update-check>Check for Updates</button>`;
  if (!s.available || !s.latest) {
    const status = s.latest ? 'Up to date' : 'Not checked';
    return `<div class="cell"><span>Status</span><span class="value">${status}</span></div>${check}`;
  }
  return `
    <div class="cell"><span>Version ${escapeHtml(s.latest)}</span><span class="value">Available</span></div>
    ${s.canInstall ? `<button type="button" class="cell cell-action" data-update-install>Install ${escapeHtml(s.latest)}</button>` : ''}
    ${s.releaseUrl ? `<a class="cell cell-action" href="${escapeHtml(s.releaseUrl)}" target="_blank" rel="noopener">Release Notes</a>` : ''}`;
}

/** One line under the update: why it failed, why not from here, or when it was checked. */
function updateNote(s: UpdateStatus): string {
  const target = s.target?.replace(/^v/, '');
  if (s.state === 'failed' && target && target !== s.current && !updateWatch.active) {
    return `The update to ${target} failed: ${s.message ?? 'no reason given'}`;
  }
  if (s.checkError) return s.checkError;
  if (s.note) return s.note;
  if (!s.checkedAt) return '';
  return `Checked ${new Date(s.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} on GitHub.`;
}

/** What the host says about itself: app, version, updates, tagline, license — and the PIN for another device. */
export class AboutPane implements Pane {
  private timer: number | null = null;

  constructor(
    private readonly store: Store<AppState>,
    private readonly settings: HostSettings,
    private readonly api: SettingsApi
  ) {}

  async render(root: HTMLElement): Promise<void> {
    await this.settings.refresh().catch(() => undefined);
    const about = this.store.get().settings?.about;
    if (!about) {
      root.innerHTML = `<div class="empty compact"><strong>Not Available</strong>The host did not answer.</div>`;
      return;
    }
    root.innerHTML = `
      <p class="group-label">Host</p>
      <div class="group" data-system><div class="cell"><span class="row-sub">Loading…</span></div></div>
      <p class="footer-note" data-system-note></p>
      <p class="group-label">Pair Another Device</p>
      <div class="group">
        <div class="cell"><span>PIN</span><span class="value pin-value" data-pin>…</span></div>
        <button type="button" class="cell cell-action" data-new-pin>New PIN</button>
      </div>
      <p class="footer-note">Open this remote on the other phone or tablet and enter the PIN. It changes after each pairing; New PIN makes the current one stop working.</p>
      <p class="group-label">About</p>
      <div class="group">
        <div class="cell"><span>App</span><span class="value">${escapeHtml(about.appName)}</span></div>
        <div class="cell"><span>Version</span><span class="value">${escapeHtml(about.versionLabel)}</span></div>
      </div>
      <p class="footer-note">${escapeHtml(about.tagline)}</p>
      <p class="group-label">Software Update</p>
      <div class="group" data-update><div class="cell"><span class="row-sub">Checking…</span></div></div>
      <p class="footer-note" data-update-note hidden></p>
      <p class="group-label">License</p>
      <div class="group">
        <div class="cell"><span>${escapeHtml(about.licenseHeadline)}</span></div>
      </div>
      <p class="footer-note">${escapeHtml(about.licenseDetail)}</p>
    `;
    const system = required(root, '[data-system]');
    const note = required(root, '[data-system-note]');
    const paint = async () => {
      try {
        const s = await this.api.system();
        system.innerHTML = systemHtml(s);
        note.textContent = `${s.hostname} · ${s.platform} · up ${duration(s.uptimeSecs)}, Harbor ${duration(s.harborUptimeSecs)}`;
      } catch {
        system.innerHTML = `<div class="cell"><span class="row-sub">The host did not answer.</span></div>`;
      }
    };
    this.dispose();
    void paint();
    this.timer = window.setInterval(() => void paint(), SYSTEM_REFRESH_MS);

    this.renderUpdate(root);

    const pinValue = required(root, '[data-pin]');
    const show = (pin: string) => {
      pinValue.textContent = pin.replace(/(\d{3})(\d{3})/, '$1 $2');
    };
    this.api
      .pairingPin()
      .then(show)
      .catch(() => {
        pinValue.textContent = '—';
      });
    required(root, '[data-new-pin]').addEventListener('click', async () => {
      try {
        show(await this.api.newPairingPin());
      } catch (err) {
        showToast(errorMessage(err, 'Could not make a new PIN'), { error: true });
      }
    });
  }

  private renderUpdate(root: HTMLElement): void {
    const group = required(root, '[data-update]');
    const note = required(root, '[data-update-note]');
    let last: UpdateStatus | null = null;
    const paint = (s: UpdateStatus | null) => {
      const shown = s ?? last;
      if (!shown) return;
      last = shown;
      group.innerHTML = updateHtml(shown, s === null);
      note.textContent = s === null ? '' : updateNote(shown);
      note.hidden = !note.textContent;
      group.querySelector<HTMLButtonElement>('[data-update-check]')?.addEventListener('click', (event) => {
        const button = event.currentTarget as HTMLButtonElement;
        button.disabled = true;
        button.textContent = 'Checking…';
        void load(true);
      });
      group.querySelector('[data-update-install]')?.addEventListener('click', () => install(shown));
    };
    const load = async (check: boolean) => {
      try {
        const s = await this.api.update(check);
        paint(s);
        if (UPDATE_RUNNING.includes(s.state)) updateWatch.start(this.api, s.current);
      } catch (err) {
        group.innerHTML = `<div class="cell"><span class="row-sub">${escapeHtml(errorMessage(err, 'The host did not answer.'))}</span></div>`;
      }
    };
    const install = (s: UpdateStatus) =>
      openConfirmDialog({
        title: `Install ${s.latest}?`,
        message:
          'Harbor downloads it from GitHub, installs it and restarts. Playback stops; the remote reloads when the host is back, after a minute or two.',
        confirmLabel: 'Install and Restart',
        onConfirm: async () => {
          const started = await this.api.installUpdate(s.tag ?? '');
          updateWatch.start(this.api, s.current);
          paint(started);
        },
      });
    updateWatch.paint = paint;
    void load(false);
  }

  dispose(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    updateWatch.paint = null;
  }
}
