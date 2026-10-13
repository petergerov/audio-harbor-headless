import type { SettingsApi } from '../../../api/settingsApi';
import type { SystemStatus } from '../../../api/types';
import { errorMessage } from '../../../core/errors';
import { escapeHtml, required } from '../../../core/html';
import type { Store } from '../../../core/store';
import type { HostSettings } from '../../../services/settingsService';
import type { AppState } from '../../../state/appState';
import { showToast } from '../../overlay';
import type { Pane } from '../settingsView';

/** How often the host's CPU / memory / disks refresh while About is open. */
const SYSTEM_REFRESH_MS = 3000;

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

/** What the host says about itself: app, version, tagline, license — and the PIN for another device. */
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

  dispose(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }
}
