import type { RecordingApi, RecordingInput, RecordingLive, RecordingSnapshot } from '../../../api/recordingApi';
import type { SettingsApi } from '../../../api/settingsApi';
import { errorMessage } from '../../../core/errors';
import { escapeAttr, escapeHtml, required } from '../../../core/html';
import { openConfirmDialog, showToast } from '../../overlay';
import { openFolderPicker } from '../../sheets/folderPicker';
import type { Pane } from '../settingsView';

const FAST_MS = 250;
const SLOW_MS = 2000;

function khz(hz: number): string {
  const k = hz / 1000;
  return `${Number.isInteger(k) ? k : k.toFixed(1)} kHz`;
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

function gigabytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(bytes < 10 * 1024 ** 3 ? 1 : 0)} GB`;
}

/** What is coming in: "44.1 kHz · 16 bit", "DSD64 via DoP", "Dolby / DTS bitstream", "No signal". */
function formatBadge(live: RecordingLive): string {
  if (!live.signal) return 'No signal';
  if (live.content === 'dop') return `DSD${Math.round((live.rate * 16) / 2822400) * 64} via DoP`;
  if (live.content === 'bitstream') return 'Dolby / DTS bitstream';
  if (live.bits === 0) return `${khz(live.rate)} · digital silence`;
  return `${khz(live.rate)} · ${live.bits} bit${live.silent ? ' · silence' : ''}`;
}

function meterHtml(peaks: number[]): string {
  const names = peaks.length === 2 ? ['L', 'R'] : peaks.map((_, i) => String(i + 1));
  return peaks
    .map((peak, i) => {
      const db = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
      const width = Number.isFinite(db) ? Math.max(0, Math.min(100, ((db + 60) / 60) * 100)) : 0;
      const label = Number.isFinite(db) ? db.toFixed(1) : '−∞';
      return `
        <div class="meter-row">
          <span>${names[i]}</span>
          <div class="meter-bar"><span style="width:${width.toFixed(1)}%"></span></div>
          <span class="meter-db">${label}</span>
        </div>`;
    })
    .join('');
}

function fileLabel(f: { kind: string; sampleRate: number; bits: number }): string {
  if (f.kind === 'dsf') return `DSD${Math.round(f.sampleRate / 44100)} (DSF)`;
  if (f.kind === 'spdif') return 'Bitstream (IEC 61937)';
  return `${khz(f.sampleRate)} · ${f.bits} bit ${f.kind.toUpperCase()}`;
}

/**
 * Recording from the host's digital input (S/PDIF HAT): the input and its rate, Record / Stop
 * with meters and the format coming in, and the last take. Polls the host while open.
 */
export class RecordingPane implements Pane {
  private root: HTMLElement | null = null;
  private timer: number | undefined;
  private snapshot: RecordingSnapshot | null = null;
  private inputs: RecordingInput[] = [];
  private busy = false;

  constructor(
    private readonly api: RecordingApi,
    private readonly settings: SettingsApi
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
    const fast = this.snapshot?.state !== 'idle';
    this.timer = window.setTimeout(() => void this.poll(), fast ? FAST_MS : SLOW_MS);
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
      else this.paintLive();
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
      <p class="group-label">Take</p>
      <div class="group" data-live></div>
      <div class="group" data-actions></div>
      <div data-last></div>
      <p class="footer-note">${snap.freeBytes !== null ? `${gigabytes(snap.freeBytes)} free where takes go. ` : ''}Default: Recordings in the first library folder. A folder inside a library folder shows up in the library; on the Pi best a USB drive, not the SD card.</p>
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
    this.paintActions();
    this.paintLive();
    this.paintLast();
  }

  private paintActions(): void {
    const root = this.root;
    const snap = this.snapshot;
    if (!root || !snap) return;
    const actions = required(root, '[data-actions]');
    if (snap.state === 'recording') {
      actions.innerHTML = `
        <button type="button" class="cell cell-action danger" data-stop>Stop and Save</button>
        <button type="button" class="cell cell-action" data-discard>Discard Take</button>`;
      required(actions, '[data-stop]').addEventListener('click', () => void this.act(() => this.api.stop()));
      required(actions, '[data-discard]').addEventListener('click', () =>
        openConfirmDialog({
          title: 'Discard this take?',
          message: 'What was recorded so far is deleted.',
          confirmLabel: 'Discard',
          onConfirm: () => this.act(() => this.api.stop(true)),
        })
      );
    } else if (snap.state === 'finalizing') {
      actions.innerHTML = `<div class="cell"><span>Writing the files…</span></div>`;
    } else {
      const enabled = snap.settings.enabled;
      actions.innerHTML = `<button type="button" class="cell cell-action" data-record ${enabled ? '' : 'disabled'}>● Record</button>`;
      required(actions, '[data-record]').addEventListener('click', () => void this.act(() => this.api.start()));
    }
  }

  private async act(fn: () => Promise<RecordingSnapshot>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      this.snapshot = await fn();
      this.paint();
    } catch (err) {
      showToast(errorMessage(err, 'Recording failed'), { error: true });
    } finally {
      this.busy = false;
      this.schedule();
    }
  }

  private paintLive(): void {
    const root = this.root;
    const snap = this.snapshot;
    if (!root || !snap) return;
    const live = root.querySelector<HTMLElement>('[data-live]');
    if (!live) return;
    if (snap.state === 'finalizing') {
      const pct = Math.round((snap.progress ?? 0) * 100);
      live.innerHTML = `
        <div class="cell"><span>Writing files</span><span class="value">${pct} %</span></div>
        <div class="cell"><div class="meter-bar" style="flex:1"><span style="width:${pct}%"></span></div></div>`;
      return;
    }
    if (snap.state !== 'recording' || !snap.live) {
      live.innerHTML = `<div class="cell"><span>${snap.settings.enabled ? 'Ready' : 'Turn Recording on to start'}</span><span class="value">${khz(snap.settings.rate)}</span></div>`;
      return;
    }
    const l = snap.live;
    const lost = l.overruns || l.dropped;
    live.innerHTML = `
      <div class="cell"><span>● ${clock(l.seconds)}</span><span class="value">${escapeHtml(formatBadge(l))}</span></div>
      <div class="cell" style="display:block">${meterHtml(l.peaks)}</div>
      <div class="cell"><span>${lost ? 'Samples lost' : 'Bit-perfect'}</span><span class="value">${
        lost ? `${l.overruns} overruns · ${l.dropped} frames` : 'no samples lost'
      }</span></div>
      ${l.error ? `<div class="cell"><span class="value" style="color:var(--danger)">${escapeHtml(l.error)}</span></div>` : ''}`;
  }

  private paintLast(): void {
    const root = this.root;
    const last = this.snapshot?.last;
    if (!root) return;
    const box = required(root, '[data-last]');
    if (!last) {
      box.innerHTML = '';
      return;
    }
    const files = last.files
      .map(
        (f) =>
          `<div class="cell"><span class="row-text">${escapeHtml(f.name)}</span><span class="value">${escapeHtml(fileLabel(f))} · ${clock(f.seconds)}</span></div>`
      )
      .join('');
    box.innerHTML = `
      <p class="group-label">Last Take</p>
      <div class="group">
        <div class="cell"><span class="row-text">${escapeHtml(last.name)}</span><span class="value">${clock(last.seconds)}</span></div>
        ${files}
        <div class="cell"><span>${last.bitPerfect ? 'Bit-perfect' : 'Samples lost'}</span><span class="value">${
          last.bitPerfect ? 'no samples lost' : `${last.overruns} overruns · ${last.dropped} frames`
        }</span></div>
        ${last.error ? `<div class="cell"><span class="value" style="color:var(--danger)">${escapeHtml(last.error)}</span></div>` : ''}
      </div>`;
  }
}
