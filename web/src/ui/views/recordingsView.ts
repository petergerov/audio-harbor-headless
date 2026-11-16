import type { AppContext } from '../../app/context';
import type { RecordingEntry, RecordingListing } from '../../api/recordingApi';
import { haptic } from '../../core/device';
import { errorMessage } from '../../core/errors';
import { escapeAttr, escapeHtml, required } from '../../core/html';
import { currentTrack } from '../../state/selectors';
import { recordingsShown } from '../components/navigationBar';
import { trackTrail } from '../components/mediaRow';
import { icons } from '../icons';
import { closeOverlay, openActionMenu, openConfirmDialog, openNameDialog, openPanel, showToast } from '../overlay';
import { clock, khz, RecorderPanel } from './recordings/recorderPanel';
import type { View, ViewHost } from './view';

/** A press this long on a row (touch) picks it up to drag; moving further first scrolls instead. */
const DRAG_PRESS_MS = 420;
const DRAG_SLOP_PX = 10;
/** A mouse drags once it moved this far with the button down. */
const MOUSE_DRAG_PX = 6;

function size(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function subtitle(e: RecordingEntry): string {
  if (e.kind === 'folder') {
    const parts = [];
    if (e.tracks) parts.push(plural(e.tracks, 'track', 'tracks'));
    if (e.folders) parts.push(plural(e.folders, 'folder', 'folders'));
    if (!parts.length) parts.push('Empty');
    if (e.bytes) parts.push(size(e.bytes));
    return parts.join(' · ');
  }
  if (e.kind === 'raw') {
    return `${e.name.endsWith('.raw.wav') ? 'Raw take, written into files at the next start' : 'Raw take (32-bit WAV)'} · ${size(e.bytes)}`;
  }
  if (e.kind === 'file') return `${(e.name.split('.').pop() ?? '').toUpperCase()} · ${size(e.bytes)}`;
  const parts: string[] = [];
  if (e.format === 'dsf') parts.push(e.sampleRate ? `DSD${Math.round(e.sampleRate / 44100)}` : 'DSD');
  else if (e.sampleRate) parts.push(`${khz(e.sampleRate)}${e.bits ? ` · ${e.bits} bit` : ''}`);
  if (e.seconds) parts.push(clock(e.seconds));
  parts.push(e.cataloguePath ? (e.format ?? '').toUpperCase() : `${(e.format ?? '').toUpperCase()} · not in the library`);
  return parts.filter(Boolean).join(' · ');
}

/** "a/b/c" → its parent "a/b" ('' at the top). */
function parentOf(p: string): string {
  return p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
}

/** Whether moving `from` into `to` is a real move (not into itself, not where it already is). */
function canDrop(from: string, to: string): boolean {
  return to !== from && !to.startsWith(`${from}/`) && parentOf(from) !== to;
}

/**
 * Recordings: Record / Stop on top, below the recordings folder as a small file manager —
 * folders to open, takes to play, and for each Rename, Move, Delete; new folders; a long press
 * (touch) or a drag (mouse) moves a row onto a folder or onto the path above the list.
 */
export class RecordingsView implements View {
  private recorder: RecorderPanel | null = null;
  private listing: RecordingListing | null = null;
  private unsubscribe: (() => void) | null = null;
  private browser: HTMLElement | null = null;
  private loadSeq = 0;
  private dragCleanup: (() => void) | null = null;

  constructor(private readonly ctx: AppContext) {}

  async render(root: HTMLElement, host: ViewHost): Promise<void> {
    this.dispose();
    const state = this.ctx.store.get();
    root.innerHTML = `
      <div class="page-header">
        <h1 class="large-title">Recordings</h1>
        ${host.headerPlayerSlot()}
      </div>
      <div data-recorder></div>
      <div data-browser></div>`;
    if (!recordingsShown(state)) {
      required(root, '[data-recorder]').innerHTML = `
        <div class="empty compact"><strong>Recording is off</strong>Switch it on in Settings → Record.</div>
        <div class="group"><button type="button" class="cell cell-action" data-open-settings>Open Settings</button></div>`;
      root.querySelector('[data-open-settings]')?.addEventListener('click', () => this.openSettings());
      return;
    }
    this.recorder = new RecorderPanel(this.ctx.recording, () => this.openSettings());
    void this.recorder.mount(required<HTMLElement>(root, '[data-recorder]'));
    const browser = required<HTMLElement>(root, '[data-browser]');
    this.browser = browser;
    this.bindBrowser(browser);
    this.unsubscribe = this.ctx.store.subscribe((now, before) => {
      if (now.recordingFilesRev !== before.recordingFilesRev) void this.load();
      if (currentTrack(now)?.cataloguePath !== currentTrack(before)?.cataloguePath) this.paint();
    });
    await this.load();
  }

  dispose(): void {
    this.recorder?.dispose();
    this.recorder = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.dragCleanup?.();
    this.dragCleanup = null;
    this.browser = null;
  }

  private openSettings(): void {
    this.ctx.nav.setSettingsPane('record');
    void this.ctx.nav.goTo('settings');
  }

  private get path(): string {
    return this.ctx.store.get().recordingsPath;
  }

  private async open(path: string): Promise<void> {
    this.ctx.store.update({ recordingsPath: path });
    await this.load();
    window.scrollTo({ top: 0 });
  }

  private async load(): Promise<void> {
    const seq = ++this.loadSeq;
    try {
      const listing = await this.ctx.recording.files(this.path);
      if (seq !== this.loadSeq || !this.browser) return;
      this.listing = listing;
    } catch (err) {
      if (seq !== this.loadSeq || !this.browser) return;
      // The folder went (renamed or deleted elsewhere): back to the top.
      if (this.path) {
        this.ctx.store.update({ recordingsPath: '' });
        await this.load();
        return;
      }
      this.browser.innerHTML = `<p class="footer-note">${escapeHtml(errorMessage(err, 'Could not list the recordings'))}</p>`;
      return;
    }
    this.paint();
  }

  private paint(): void {
    const box = this.browser;
    const listing = this.listing;
    if (!box || !listing) return;
    const playing = currentTrack(this.ctx.store.get())?.cataloguePath;
    const parts = listing.path ? listing.path.split('/') : [];
    const crumbs = [
      `<button type="button" class="rec-crumb" data-crumb="" data-drop="">Recordings</button>`,
      ...parts.map((name, i) => {
        const p = parts.slice(0, i + 1).join('/');
        return `<span class="rec-crumb-sep">›</span><button type="button" class="rec-crumb" data-crumb="${escapeAttr(p)}" data-drop="${escapeAttr(p)}">${escapeHtml(name)}</button>`;
      }),
    ].join('');
    const audio = listing.entries.filter((e) => e.kind === 'audio' && e.cataloguePath);
    const rows = listing.entries.map((e, i) => this.rowHtml(e, `e${i}`, playing)).join('');
    const raw = listing.raw.map((e, i) => this.rowHtml(e, `r${i}`, playing)).join('');
    box.innerHTML = `
      <div class="rec-bar">
        <nav class="rec-crumbs" aria-label="Folder">${crumbs}</nav>
        <div class="rec-tools">
          ${audio.length ? `<button type="button" class="nav-link accent" data-play-here>Play all</button>` : ''}
          <button type="button" class="nav-link" data-new-folder>New Folder</button>
        </div>
      </div>
      ${
        rows
          ? `<div class="group rec-list">${rows}</div>`
          : `<div class="group"><div class="empty compact"><strong>${listing.path ? 'Empty folder' : 'No recordings yet'}</strong>${
              listing.path ? 'Drag takes here, or go back up.' : 'Takes show up here after Stop and Save.'
            }</div></div>`
      }
      ${raw ? `<p class="group-label">Raw Takes</p><div class="group rec-list">${raw}</div>` : ''}
      <p class="footer-note">${escapeHtml(listing.root)}${
        listing.inLibrary ? '' : ' — outside the library folders: add it under Settings → Sources to play takes here.'
      }<br />Long press (or drag with the mouse) to move a take onto a folder or onto the path above.</p>`;
  }

  private rowHtml(e: RecordingEntry, key: string, playing: string | undefined): string {
    const isPlaying = Boolean(e.cataloguePath && e.cataloguePath === playing);
    const tile = e.kind === 'folder' ? icons.tileFolder : e.kind === 'audio' ? icons.tileNote : icons.record;
    let trail = `<span class="row-trail"></span>`;
    if (e.kind === 'folder') trail = `<span class="row-trail chevron">${icons.chevron}</span>`;
    else if (e.kind === 'audio' && e.cataloguePath) {
      const paused = isPlaying && this.ctx.store.get().nowPlaying?.state !== 'playing';
      trail = `<span class="row-trail track">${trackTrail(isPlaying ? (paused ? 'paused' : 'playing') : 'idle')}</span>`;
    }
    const title = e.kind === 'audio' && e.title && e.title !== e.name.replace(/\.[^.]+$/, '') ? `${e.title}` : e.name;
    const drop = e.kind === 'folder' ? ` data-drop="${escapeAttr(e.path)}"` : '';
    const drag = e.kind === 'raw' ? '' : ' data-drag';
    return `
      <div class="row-wrap${isPlaying ? ' playing' : ''}" data-key="${key}"${drop}${drag}>
        <button type="button" class="row has-icon${isPlaying ? ' playing' : ''}">
          <div class="row-icon ${e.kind === 'folder' ? 'folder' : 'track'}">${tile}</div>
          <div class="row-text"><div class="row-title">${escapeHtml(title)}</div><div class="row-sub">${escapeHtml(subtitle(e))}</div></div>
          ${trail}
        </button>
        <button type="button" class="row-more" aria-label="Actions for ${escapeAttr(e.name)}"><span class="more-glyph">···</span></button>
      </div>`;
  }

  private entryOf(el: Element | null): RecordingEntry | null {
    const key = el?.closest<HTMLElement>('[data-key]')?.dataset.key;
    if (!key || !this.listing) return null;
    const list = key.startsWith('r') ? this.listing.raw : this.listing.entries;
    return list[Number(key.slice(1))] ?? null;
  }

  /** One set of listeners on the browser box; rows are found by their key. */
  private bindBrowser(box: HTMLElement): void {
    let swallowClick = false;
    box.addEventListener('click', (event) => {
      const target = event.target as Element;
      if (swallowClick) {
        swallowClick = false;
        event.preventDefault();
        return;
      }
      const crumb = target.closest<HTMLElement>('[data-crumb]');
      if (crumb) {
        void this.open(crumb.dataset.crumb ?? '');
        return;
      }
      if (target.closest('[data-new-folder]')) {
        this.newFolder();
        return;
      }
      if (target.closest('[data-play-here]') && this.listing) {
        void this.ctx.actions.play({ folder: this.listing.absolute });
        return;
      }
      const entry = this.entryOf(target);
      if (!entry) return;
      if (target.closest('.row-more')) {
        this.menu(entry);
        return;
      }
      if (target.closest('.row')) this.activate(entry);
    });
    box.addEventListener('contextmenu', (event) => {
      const entry = this.entryOf(event.target as Element);
      if (!entry) return;
      event.preventDefault();
      // Android's long press also fires this: that press is a drag here.
      if (document.documentElement.classList.contains('rec-drag-active')) return;
      this.menu(entry);
    });
    this.dragCleanup = bindDrag(box, {
      canDrag: (row) => row.hasAttribute('data-drag'),
      entryOf: (row) => this.entryOf(row),
      onDrop: (entry, to) => void this.moveTo([entry], to),
      swallowNextClick: () => {
        swallowClick = true;
        window.setTimeout(() => (swallowClick = false), 400);
      },
    });
  }

  private absolute(entry: RecordingEntry): string {
    return `${this.listing?.root ?? ''}/${entry.path}`;
  }

  private activate(entry: RecordingEntry): void {
    if (entry.kind === 'folder') {
      void this.open(entry.path);
      return;
    }
    if (entry.kind === 'audio') {
      if (!entry.cataloguePath) {
        showToast(this.listing?.inLibrary ? 'Not read into the library yet — try again in a moment' : 'Not in the library');
        return;
      }
      void this.ctx.actions.play({ folder: this.listing!.absolute, cataloguePath: entry.cataloguePath });
      return;
    }
    this.menu(entry);
  }

  private menu(entry: RecordingEntry): void {
    const first = [];
    if (entry.kind === 'folder') {
      first.push({ label: 'Open', run: () => this.open(entry.path) });
      if ((entry.tracks || entry.folders) && this.listing?.inLibrary) {
        first.push({ label: 'Play', run: () => this.ctx.actions.play({ folder: this.absolute(entry) }) });
      }
    } else if (entry.kind === 'audio' && entry.cataloguePath) {
      first.push({ label: 'Play', run: () => this.ctx.actions.play({ folder: this.listing!.absolute, cataloguePath: entry.cataloguePath }) });
    }
    const manage =
      entry.kind === 'raw'
        ? []
        : [
            { label: 'Rename…', run: () => this.rename(entry) },
            { label: 'Move to…', run: () => this.pickTarget(entry) },
          ];
    openActionMenu({
      title: entry.name,
      subtitle: subtitle(entry),
      groups: [first, manage, [{ label: 'Delete…', danger: true, run: () => this.remove(entry) }]],
    });
  }

  private newFolder(): void {
    openNameDialog({
      title: 'New Folder',
      placeholder: 'Folder name',
      confirmLabel: 'Create',
      onConfirm: async (name) => {
        await this.ctx.recording.createFolder(this.path, name);
        await this.load();
      },
    });
  }

  private rename(entry: RecordingEntry): void {
    const ext = entry.kind === 'folder' ? '' : (entry.name.match(/\.[^.]+$/)?.[0] ?? '');
    openNameDialog({
      title: entry.kind === 'folder' ? 'Rename Folder' : 'Rename',
      placeholder: 'Name',
      initial: ext ? entry.name.slice(0, -ext.length) : entry.name,
      confirmLabel: 'Rename',
      onConfirm: async (name) => {
        await this.ctx.recording.rename(entry.path, name);
        await this.load();
      },
    });
  }

  private remove(entry: RecordingEntry): void {
    const what =
      entry.kind === 'folder'
        ? `The folder and everything in it${entry.tracks ? ` (${plural(entry.tracks, 'track', 'tracks')})` : ''} is deleted from the disk.`
        : 'The file is deleted from the disk.';
    openConfirmDialog({
      title: `Delete ${entry.name}?`,
      message: `${what} This cannot be undone.`,
      confirmLabel: 'Delete',
      onConfirm: async () => {
        await this.ctx.recording.remove([entry.path]);
        showToast(`Deleted ${entry.name}`);
        await this.load();
      },
    });
  }

  private async moveTo(entries: RecordingEntry[], to: string): Promise<void> {
    const moving = entries.filter((e) => canDrop(e.path, to));
    if (!moving.length) return;
    try {
      await this.ctx.recording.move(
        moving.map((e) => e.path),
        to
      );
      haptic('light');
      showToast(`Moved to ${to ? to.split('/').pop() : 'Recordings'}`);
    } catch (err) {
      showToast(errorMessage(err, 'Could not move'), { error: true });
    }
    await this.load();
  }

  /** Move to…: every folder of the recordings folder, the top first. */
  private async pickTarget(entry: RecordingEntry): Promise<void> {
    let folders: Array<{ path: string; name: string; depth: number }>;
    try {
      folders = await this.ctx.recording.folders();
    } catch (err) {
      showToast(errorMessage(err, 'Could not list the folders'), { error: true });
      return;
    }
    const all = [{ path: '', name: 'Recordings', depth: 0 }, ...folders];
    const rows = all
      .map((f) => {
        const ok = canDrop(entry.path, f.path);
        return `<button type="button" class="cell" data-target="${escapeAttr(f.path)}" ${ok ? '' : 'disabled'} style="padding-left:${16 + f.depth * 18}px">
          <span class="row-text"><span class="row-title">${escapeHtml(f.name)}</span></span>
          ${f.path === parentOf(entry.path) ? '<span class="value">here now</span>' : ''}
        </button>`;
      })
      .join('');
    openPanel({
      title: 'Move To',
      subtitle: entry.name,
      bodyHtml: `<div class="group folder-group rec-targets">${rows}</div>`,
      bind: (root) => {
        root.querySelectorAll<HTMLButtonElement>('[data-target]').forEach((button) =>
          button.addEventListener('click', () => {
            if (button.disabled) return;
            closeOverlay();
            void this.moveTo([entry], button.dataset.target ?? '');
          })
        );
      },
    });
  }
}

/**
 * Drag a row onto a folder row or a path segment (`[data-drop]`). Touch: a long press picks the
 * row up (moving first scrolls as usual); mouse: dragging with the button down. A label follows
 * the finger, the target lights up, and the list scrolls near the screen's edges.
 */
function bindDrag(
  box: HTMLElement,
  opts: {
    canDrag: (row: HTMLElement) => boolean;
    entryOf: (row: HTMLElement) => RecordingEntry | null;
    onDrop: (entry: RecordingEntry, to: string) => void;
    swallowNextClick: () => void;
  }
): () => void {
  let pending: { row: HTMLElement; x: number; y: number; timer?: number; mouse: boolean } | null = null;
  let drag: { entry: RecordingEntry; row: HTMLElement; ghost: HTMLElement; target: HTMLElement | null } | null = null;
  let scrollTimer: number | undefined;
  let lastY = 0;

  const begin = (row: HTMLElement, x: number, y: number) => {
    const entry = opts.entryOf(row);
    if (!entry) return;
    haptic('medium');
    const ghost = document.createElement('div');
    ghost.className = 'rec-ghost';
    ghost.textContent = entry.name;
    document.body.appendChild(ghost);
    row.classList.add('rec-dragging');
    document.documentElement.classList.add('rec-drag-active');
    drag = { entry, row, ghost, target: null };
    moveTo(x, y);
  };

  const moveTo = (x: number, y: number) => {
    if (!drag) return;
    lastY = y;
    drag.ghost.style.transform = `translate(${x + 12}px, ${y - 20}px)`;
    const under = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-drop]') ?? null;
    const ok = under && box.contains(under) && canDrop(drag.entry.path, under.dataset.drop ?? '') ? under : null;
    if (ok !== drag.target) {
      drag.target?.classList.remove('rec-drop');
      ok?.classList.add('rec-drop');
      drag.target = ok;
    }
    // Near the top or bottom edge: scroll so far-away folders can be reached.
    if (scrollTimer === undefined) {
      scrollTimer = window.setInterval(() => {
        const edge = 90;
        const bottom = window.innerHeight - 140;
        if (lastY < edge) window.scrollBy(0, -12);
        else if (lastY > bottom) window.scrollBy(0, 12);
      }, 16);
    }
  };

  const end = (drop: boolean) => {
    window.clearTimeout(pending?.timer);
    pending?.row.classList.remove('pressing');
    pending = null;
    window.clearInterval(scrollTimer);
    scrollTimer = undefined;
    if (!drag) return;
    const { entry, row, ghost, target } = drag;
    drag = null;
    ghost.remove();
    row.classList.remove('rec-dragging');
    target?.classList.remove('rec-drop');
    document.documentElement.classList.remove('rec-drag-active');
    opts.swallowNextClick();
    if (drop && target) opts.onDrop(entry, target.dataset.drop ?? '');
  };

  const rowAt = (target: EventTarget | null) => {
    const el = target instanceof Element ? target : null;
    if (!el?.closest('.row') || el.closest('.row-more')) return null;
    const row = el.closest<HTMLElement>('.row-wrap');
    return row && box.contains(row) && opts.canDrag(row) ? row : null;
  };

  // Touch: long press picks up; while dragging the page does not scroll.
  const onTouchStart = (event: TouchEvent) => {
    const touch = event.touches[0];
    const row = rowAt(event.target);
    if (event.touches.length !== 1 || !touch || !row) return;
    pending = { row, x: touch.clientX, y: touch.clientY, mouse: false };
    pending.timer = window.setTimeout(() => {
      if (!pending) return;
      const p = pending;
      p.row.classList.remove('pressing');
      pending = null;
      begin(p.row, p.x, p.y);
    }, DRAG_PRESS_MS);
    row.classList.add('pressing');
  };
  const onTouchMove = (event: TouchEvent) => {
    const touch = event.touches[0];
    if (!touch) return;
    if (drag) {
      event.preventDefault();
      moveTo(touch.clientX, touch.clientY);
      return;
    }
    if (pending && Math.hypot(touch.clientX - pending.x, touch.clientY - pending.y) > DRAG_SLOP_PX) end(false);
  };
  const onTouchEnd = () => end(true);
  const onTouchCancel = () => end(false);

  // Mouse: press and move.
  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    const row = rowAt(event.target);
    if (!row) return;
    pending = { row, x: event.clientX, y: event.clientY, mouse: true };
  };
  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse') return;
    if (drag) {
      moveTo(event.clientX, event.clientY);
      return;
    }
    if (pending?.mouse && Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > MOUSE_DRAG_PX) {
      const p = pending;
      pending = null;
      begin(p.row, event.clientX, event.clientY);
    }
  };
  const onPointerUp = (event: PointerEvent) => {
    if (event.pointerType === 'mouse') end(true);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') end(false);
  };

  box.addEventListener('touchstart', onTouchStart, { passive: true });
  document.addEventListener('touchmove', onTouchMove, { passive: false });
  document.addEventListener('touchend', onTouchEnd);
  document.addEventListener('touchcancel', onTouchCancel);
  box.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('keydown', onKey);
  return () => {
    end(false);
    box.removeEventListener('touchstart', onTouchStart);
    document.removeEventListener('touchmove', onTouchMove);
    document.removeEventListener('touchend', onTouchEnd);
    document.removeEventListener('touchcancel', onTouchCancel);
    box.removeEventListener('pointerdown', onPointerDown);
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('keydown', onKey);
  };
}
