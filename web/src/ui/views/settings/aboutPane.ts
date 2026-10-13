import type { SettingsApi } from '../../../api/settingsApi';
import { errorMessage } from '../../../core/errors';
import { escapeHtml, required } from '../../../core/html';
import type { Store } from '../../../core/store';
import type { HostSettings } from '../../../services/settingsService';
import type { AppState } from '../../../state/appState';
import { showToast } from '../../overlay';
import type { Pane } from '../settingsView';

/** What the host says about itself: app, version, tagline, license — and the PIN for another device. */
export class AboutPane implements Pane {
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
}
