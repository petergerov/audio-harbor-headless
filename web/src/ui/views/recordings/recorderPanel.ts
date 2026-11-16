import type { RecordingApi, RecordingLive, RecordingSnapshot } from '../../../api/recordingApi';
import { errorMessage } from '../../../core/errors';
import { escapeHtml, required } from '../../../core/html';
import { openConfirmDialog, showToast } from '../../overlay';

const FAST_MS = 250;
const SLOW_MS = 2000;

export function khz(hz: number): string {
  const k = hz / 1000;
  return `${Number.isInteger(k) ? k : k.toFixed(1)} kHz`;
}

export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

export function gigabytes(bytes: number): string {
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

/**
 * Record / Stop with the clock, meters and the format coming in, and how the last take came out.
 * Polls the host while on screen (fast while a take runs). The settings live in Settings → Record.
 */
export class RecorderPanel {
  private root: HTMLElement | null = null;
  private timer: number | undefined;
  private snapshot: RecordingSnapshot | null = null;
  private busy = false;

  constructor(
    private readonly api: RecordingApi,
    private readonly openSettings: () => void
  ) {}

  async mount(root: HTMLElement): Promise<void> {
    this.dispose();
    this.root = root;
    try {
      this.snapshot = await this.api.snapshot();
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
    if (!this.root?.isConnected) return;
    try {
      const next = await this.api.snapshot();
      const before = this.snapshot;
      this.snapshot = next;
      const repaint =
        !before ||
        next.state !== before.state ||
        next.available !== before.available ||
        next.settings.enabled !== before.settings.enabled ||
        next.settings.rate !== before.settings.rate ||
        next.last?.name !== before.last?.name;
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
    root.innerHTML = `
      <div class="group rec-panel" data-live></div>
      <div class="group" data-actions></div>
      ${
        snap.inputAccess === 'denied'
          ? `<p class="footer-note" style="color:var(--danger)">macOS does not let Audio Harbor read audio inputs. Turn it on in System Settings → Privacy &amp; Security → Microphone → Audio Harbor, then restart Audio Harbor.</p>`
          : ''
      }
      <div data-last></div>`;
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
        <button type="button" class="cell cell-action rec-stop" data-stop>■ Stop and Save</button>
        <button type="button" class="cell cell-action danger" data-discard>Discard Take</button>`;
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
      actions.innerHTML = `
        <button type="button" class="cell cell-action rec-start" data-record>● Record</button>
        <button type="button" class="cell" data-settings>
          <span>Input &amp; Format</span><span class="value">${khz(snap.settings.rate)} ›</span>
        </button>`;
      required(actions, '[data-record]').addEventListener('click', () => void this.act(() => this.api.start()));
      required(actions, '[data-settings]').addEventListener('click', () => this.openSettings());
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
      const free = snap.freeBytes !== null ? `${gigabytes(snap.freeBytes)} free` : '';
      live.innerHTML = `<div class="cell"><span>Ready</span><span class="value">${free}</span></div>`;
      return;
    }
    const l = snap.live;
    const lost = l.overruns || l.dropped;
    live.innerHTML = `
      <div class="cell"><span class="rec-clock">● ${clock(l.seconds)}</span><span class="value">${escapeHtml(formatBadge(l))}</span></div>
      <div class="cell" style="display:block">${meterHtml(l.peaks)}</div>
      <div class="cell"><span>${lost ? 'Samples lost' : 'Bit-perfect'}</span><span class="value">${
        lost ? `${l.overruns} overruns · ${l.dropped} frames` : 'no samples lost'
      }</span></div>
      ${l.error ? `<div class="cell"><span class="value" style="color:var(--danger)">${escapeHtml(l.error)}</span></div>` : ''}`;
  }

  /** How the last take came out (its files show in the list below). */
  private paintLast(): void {
    const root = this.root;
    const last = this.snapshot?.last;
    if (!root) return;
    const box = required(root, '[data-last]');
    if (!last || this.snapshot?.state !== 'idle') {
      box.innerHTML = '';
      return;
    }
    const verdict = last.error
      ? `<span style="color:var(--danger)">${escapeHtml(last.error)}</span>`
      : last.bitPerfect
        ? 'bit-perfect, no samples lost'
        : `samples lost (${last.overruns} overruns · ${last.dropped} frames)`;
    box.innerHTML = `<p class="footer-note">Last take: ${escapeHtml(last.name)} · ${clock(last.seconds)} · ${verdict}</p>`;
  }
}
