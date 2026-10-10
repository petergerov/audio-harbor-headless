import { errorMessage } from '../../../core/errors';
import { escapeHtml, required } from '../../../core/html';
import type { Store } from '../../../core/store';
import type { HostSettings } from '../../../services/settingsService';
import type { AppState } from '../../../state/appState';
import { showToast } from '../../overlay';
import type { Pane } from '../settingsView';

/** The DLNA music server: on or off at once, what it is doing, and how many streams it serves. */
export class SharingPane implements Pane {
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly store: Store<AppState>,
    private readonly settings: HostSettings
  ) {}

  async render(root: HTMLElement): Promise<void> {
    this.dispose();
    root.innerHTML = `
      <div class="group">
        <label class="cell">
          <span>Share Library on the Network</span>
          <input type="checkbox" role="switch" class="switch" data-sharing />
        </label>
        <div class="cell"><span>Streams Now</span><span class="value" data-streams></span></div>
      </div>
      <p class="footer-note" data-sharing-note></p>
    `;
    const toggle = required<HTMLInputElement>(root, '[data-sharing]');
    const streams = required(root, '[data-streams]');
    const note = required(root, '[data-sharing-note]');
    let busy = false;
    const paint = () => {
      const sharing = this.store.get().settings?.sharing;
      toggle.checked = Boolean(sharing?.enabled);
      toggle.disabled = busy;
      streams.textContent = String(sharing?.activeStreams ?? 0);
      const status = sharing?.statusText ?? (sharing ? '' : 'Loading…');
      note.innerHTML = [
        status,
        'Players and apps on the network can browse the library and play the files themselves (DLNA).',
      ]
        .filter(Boolean)
        .map((line) => escapeHtml(line))
        .join('<br><br>');
    };
    toggle.addEventListener('change', async () => {
      const want = toggle.checked;
      busy = true;
      paint();
      try {
        await this.settings.apply({ sharingEnabled: { value: want } });
      } catch (err) {
        toggle.checked = !want;
        showToast(errorMessage(err, 'Could not change sharing'), { error: true });
      }
      busy = false;
      paint();
    });
    this.unsubscribe = this.store.subscribe((state, previous) => {
      if (state.settings !== previous.settings && !busy) paint();
    });
    paint();
    try {
      await this.settings.refresh();
    } catch (err) {
      showToast(errorMessage(err, 'Could not load sharing status'), { error: true });
    }
    paint();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
