import type { RecordingApi, RecordingInput, RecordingSnapshot } from '../../../api/recordingApi';
import type { SettingsApi } from '../../../api/settingsApi';
import { errorMessage } from '../../../core/errors';
import { escapeAttr, escapeHtml, required } from '../../../core/html';
import { showToast } from '../../overlay';
import { openFolderPicker } from '../../sheets/folderPicker';
import { gigabytes, khz } from '../recordings/recorderPanel';
import type { Pane } from '../settingsView';

/** While open: a take starting or ending elsewhere locks or frees the input settings. */
const POLL_MS = 2000;

/**
 * Recording settings: on / off (shows Recordings in the navigation), the input and its rate,
 * where takes go, split and raw. Record / Stop and the takes themselves are in Recordings.
 */
export class RecordingPane implements Pane {
  private root: HTMLElement | null = null;
  private timer: number | undefined;
  private snapshot: RecordingSnapshot | null = null;
  private inputs: RecordingInput[] = [];

  constructor(
    private readonly api: RecordingApi,
    private readonly settings: SettingsApi,
    private readonly openRecordings: () => void
  ) {}

  async render(root: HTMLElement): Promise<void> {
    this.dispose();
    this.root = root;
    try {
      [this.snapshot, this.inputs] = await Promise.all([this.api.snapshot(), this.api.inputs()]);
    } catch (err) {
      root.innerHTML = `<p class="footer-note">${escapeHtml(errorMessage(err, 'Could not reach the recorder'))}</p>`;
      return;
    }
    this.paint();
    this.schedule();
  }

  dispose(): void {
    window.clearTimeout(this.timer);
    this.timer = undefined;
    this.root = null;
  }

  private schedule(): void {
    window.clearTimeout(this.timer);
    if (!this.root) return;
    this.timer = window.setTimeout(() => void this.poll(), POLL_MS);
  }

  private async poll(): Promise<void> {
    if (!this.root) return;
    try {
      const next = await this.api.snapshot();
      const repaint =
        !this.snapshot ||
        next.available !== this.snapshot.available ||
        next.state !== this.snapshot.state ||
        JSON.stringify(next.settings) !== JSON.stringify(this.snapshot.settings);
      this.snapshot = next;
      if (repaint) this.paint();
    } catch {
      // host away for a moment: try again
    }
    this.schedule();
  }

  private paint(): void {
    const root = this.root;
    const snap = this.snapshot;
    if (!root || !snap) return;
    if (!snap.available) {
      root.innerHTML = `
        <p class="group-label">Recording</p>
        <div class="group"><div class="cell"><span>No digital input on this host</span></div></div>
        <p class="footer-note">Recording needs an S/PDIF input: on a Raspberry Pi the HiFiBerry Digi+ I/O (<code>dtoverlay=hifiberry-digi</code> in config.txt), on a Mac an audio interface with a digital input. It records bit-perfect, in the format the source sends.</p>`;
      return;
    }
    const s = snap.settings;
    const locked = snap.state !== 'idle';
    const inputs = [...this.inputs];
    if (s.device && !inputs.some((i) => i.id === s.device)) inputs.push({ id: s.device, name: `${s.device} (not found)` });
    const inputOptions = [
      `<option value="" ${s.device ? '' : 'selected'}>First found${this.inputs[0] ? ` (${escapeHtml(this.inputs[0].name)})` : ''}</option>`,
      ...inputs.map(
        (i) => `<option value="${escapeAttr(i.id)}" ${i.id === s.device ? 'selected' : ''}>${escapeHtml(i.name)}</option>`
      ),
    ].join('');
    const rateOptions = snap.rates
      .map((r) => `<option value="${r}" ${r === s.rate ? 'selected' : ''}>${khz(r)}</option>`)
      .join('');

    root.innerHTML = `
      <p class="group-label">Digital Input</p>
      <div class="group">
        <label class="cell">
          <span>Recording</span>
          <input type="checkbox" role="switch" class="switch" data-enabled ${s.enabled ? 'checked' : ''} ${locked ? 'disabled' : ''} />
        </label>
        <div class="cell">
          <label for="rec-input">Input</label>
          <select id="rec-input" ${locked ? 'disabled' : ''}>${inputOptions}</select>
        </div>
        <div class="cell">
          <label for="rec-rate">Sample Rate</label>
          <select id="rec-rate" ${locked ? 'disabled' : ''}>${rateOptions}</select>
        </div>
        <button type="button" class="cell" data-folder ${locked ? 'disabled' : ''}>
          <span style="flex-shrink:0">Save To</span>
          <span class="value">${escapeHtml(snap.folder)}</span>
        </button>
        ${
          s.folder && !locked
            ? `<button type="button" class="cell cell-action" data-folder-default>Use Default Folder</button>`
            : ''
        }
        <label class="cell">
          <span>Split Tracks at Silence</span>
          <input type="checkbox" role="switch" class="switch" data-split ${s.split === 'silence' ? 'checked' : ''} ${locked ? 'disabled' : ''} />
        </label>
        <label class="cell">
          <span>Keep Raw Take</span>
          <input type="checkbox" role="switch" class="switch" data-raw ${s.keep_raw ? 'checked' : ''} />
        </label>
      </div>
      ${
        snap.inputAccess === 'denied'
          ? `<p class="footer-note" style="color:var(--danger)">macOS does not let Audio Harbor read audio inputs. Turn it on in System Settings → Privacy &amp; Security → Microphone → Audio Harbor, then restart Audio Harbor.</p>`
          : snap.inputAccess === 'undetermined'
            ? `<p class="footer-note">On the first Record, macOS asks on the Mac whether Audio Harbor may use audio inputs — allow it there.</p>`
            : ''
      }
      <p class="footer-note">Set the rate the source sends: the input cannot tell it, and nothing is resampled. On a Mac, set the interface's clock source to S/PDIF (external). Files come out as the source sent them — FLAC at the bit depth really used (16 or 24), DSD from DoP as DSF, Dolby / DTS as a raw bitstream.</p>
      <p class="footer-note">${snap.freeBytes !== null ? `${gigabytes(snap.freeBytes)} free where takes go. ` : ''}Default: Recordings in the first library folder. A folder inside a library folder shows up in the library; on the Pi best a USB drive, not the SD card. Keep Raw Take keeps the unprocessed 32-bit capture next to the files (in .takes; delete it in Recordings).</p>
      ${
        s.enabled
          ? `<div class="group"><button type="button" class="cell cell-action" data-open-recordings>${
              snap.state === 'recording' ? '● Recording — Open Recordings' : 'Record and Manage Takes in Recordings'
            }</button></div>`
          : '<p class="footer-note">Switch Recording on: Recordings then shows in the menu, below Catalogue.</p>'
      }
    `;

    const save = async (patch: Parameters<RecordingApi['updateSettings']>[0]) => {
      try {
        this.snapshot = await this.api.updateSettings(patch);
        this.paint();
      } catch (err) {
        showToast(errorMessage(err, 'Could not save'), { error: true });
        this.paint();
      }
    };
    required<HTMLInputElement>(root, '[data-enabled]').addEventListener('change', (e) =>
      void save({ enabled: (e.target as HTMLInputElement).checked })
    );
    required<HTMLSelectElement>(root, '#rec-input').addEventListener('change', (e) =>
      void save({ device: (e.target as HTMLSelectElement).value })
    );
    required<HTMLSelectElement>(root, '#rec-rate').addEventListener('change', (e) =>
      void save({ rate: Number((e.target as HTMLSelectElement).value) })
    );
    required(root, '[data-folder]').addEventListener('click', () =>
      openFolderPicker({
        api: this.settings,
        confirmLabel: 'Use',
        // From the folder above: the take folder may not exist before the first take.
        start: snap.folder.replace(/[\\/][^\\/]+[\\/]?$/, '') || undefined,
        onPick: async (folder) => {
          await save({ folder });
          showToast('Takes go to ' + folder);
        },
      })
    );
    root.querySelector('[data-folder-default]')?.addEventListener('click', () => void save({ folder: '' }));
    required<HTMLInputElement>(root, '[data-split]').addEventListener('change', (e) =>
      void save({ split: (e.target as HTMLInputElement).checked ? 'silence' : 'none' })
    );
    required<HTMLInputElement>(root, '[data-raw]').addEventListener('change', (e) =>
      void save({ keep_raw: (e.target as HTMLInputElement).checked })
    );
    root.querySelector('[data-open-recordings]')?.addEventListener('click', () => this.openRecordings());
  }
}
