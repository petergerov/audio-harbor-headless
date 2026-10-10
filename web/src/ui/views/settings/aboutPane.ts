import { escapeHtml } from '../../../core/html';
import type { Store } from '../../../core/store';
import type { HostSettings } from '../../../services/settingsService';
import type { AppState } from '../../../state/appState';
import type { Pane } from '../settingsView';

/** What the host says about itself: app, version, tagline, license. */
export class AboutPane implements Pane {
  constructor(
    private readonly store: Store<AppState>,
    private readonly settings: HostSettings
  ) {}

  async render(root: HTMLElement): Promise<void> {
    await this.settings.refresh().catch(() => undefined);
    const about = this.store.get().settings?.about;
    if (!about) {
      root.innerHTML = `<div class="empty compact"><strong>Not Available</strong>The host did not answer.</div>`;
      return;
    }
    root.innerHTML = `
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
  }
}
