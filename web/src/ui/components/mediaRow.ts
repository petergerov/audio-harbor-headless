import { haptic } from '../../core/device';
import { escapeAttr, escapeHtml } from '../../core/html';
import { icons } from '../icons';
import type { Covers } from './covers';

export type RowKind = 'album' | 'artist' | 'folder' | 'track' | 'playlist' | 'label';

/** What one list row shows. */
export interface RowModel {
  kind: RowKind;
  title: string;
  subtitle: string;
  /** Opens a level deeper (album, artist, folder, collection). */
  chevron: boolean;
  /** A cover in place of the kind's tile (albums; the queue's tracks). */
  artworkHash?: string | null;
  /** The track loaded now. */
  playing?: boolean;
  /** …and paused. */
  paused?: boolean;
  /** On a folder, drive or share that is not connected: greyed out, not playable. */
  unavailable?: boolean;
}

/** One row: what it shows and what a tap, `···`, a long press or a right click do. */
export interface RowEntry {
  row: RowModel;
  /** A promise (a track starting) shows the row as loading until it settles. */
  onOpen: () => void | Promise<unknown>;
  onMore: () => void;
  moreLabel: string;
  /** Track rows: the path marks the playing one. */
  path?: string;
  /** A long press (touch) or right click opens `onMore`. */
  contextMenu?: boolean;
}

/** How long a press must last to open the row's actions, and how far the finger may drift. */
const LONG_PRESS_MS = 480;
const LONG_PRESS_SLOP_PX = 10;
/** Android fires `contextmenu` after a long press too: the second within this long is dropped. */
const MENU_DEBOUNCE_MS = 800;

/** The tile each kind of row shows without a cover — as in the iOS remote. */
const TILES: Record<RowKind, string> = {
  album: icons.tileSpeaker,
  artist: icons.tilePerson,
  folder: icons.tileFolder,
  track: icons.tileNote,
  playlist: icons.tileList,
  label: icons.tileTag,
};

/** A track row's end: play (not loaded), the speaker (playing) or a quiet speaker (paused). */
export type TrackMark = 'idle' | 'playing' | 'paused';

export function trackTrail(mark: TrackMark): string {
  if (mark === 'playing') return `<span class="playing-glyph" aria-label="Now playing">${icons.speaker}</span>`;
  if (mark === 'paused') return `<span class="playing-glyph" aria-label="Paused">${icons.speakerOff}</span>`;
  return `<span class="play-glyph" aria-hidden="true">${icons.trailPlay}</span>`;
}

function rowHtml(row: RowModel, covers: Covers): string {
  const img = covers.img(row.artworkHash);
  const icon = img
    ? `<div class="row-icon ${row.kind} has-art">${img}</div>`
    : `<div class="row-icon ${row.kind}">${TILES[row.kind]}</div>`;
  let trail = `<span class="row-trail"></span>`;
  if (row.kind === 'track') {
    const mark: TrackMark = row.playing ? (row.paused ? 'paused' : 'playing') : 'idle';
    trail = `<span class="row-trail track${row.playing ? ' playing' : ''}" data-mark="${mark}">${trackTrail(mark)}</span>`;
  } else if (row.chevron) {
    trail = `<span class="row-trail chevron">${icons.chevron}</span>`;
  }
  return `${icon}<div class="row-text"><div class="row-title">${escapeHtml(row.title)}</div><div class="row-sub">${escapeHtml(row.subtitle)}</div></div>${trail}`;
}

function wrapHtml(entry: RowEntry, index: number, covers: Covers): string {
  const { row } = entry;
  const wrapClass = `row-wrap${row.unavailable ? ' unavailable' : ''}${row.playing ? ' playing' : ''}`;
  const path = entry.path ? ` data-path="${escapeAttr(entry.path)}"` : '';
  // Folders and albums still open when not connected (the catalogue shows them); a track does not play.
  const disabled = row.unavailable && row.kind === 'track' ? ' aria-disabled="true"' : '';
  return (
    `<div class="${wrapClass}" data-row="${index}"${path}>` +
    `<button type="button" class="row has-icon${row.playing ? ' playing' : ''}"${disabled}>${rowHtml(row, covers)}</button>` +
    `<button type="button" class="row-more" aria-label="${escapeAttr(entry.moreLabel)}"><span class="more-glyph">···</span></button>` +
    `</div>`
  );
}

/** The rows each container shows; its events are bound once and find the row by its index. */
const rowsOf = new WeakMap<HTMLElement, RowEntry[]>();

/**
 * Fills `list` with `entries` — one parse for all of them, and one set of listeners on the list
 * (not one per row), so a folder of thousands of tracks paints at once. Anything in `list` before
 * is replaced.
 */
export function paintRows(list: HTMLElement, entries: RowEntry[], covers: Covers): void {
  const first = !rowsOf.has(list);
  rowsOf.set(list, entries);
  list.innerHTML = entries.map((entry, i) => wrapHtml(entry, i, covers)).join('');
  if (first) bindRows(list, (wrap) => rowsOf.get(list)?.[Number(wrap.dataset.row)]);
  covers.hydrate(list);
}

/** Tap, `···`, long press and right click for every row inside `container`. */
function bindRows(container: HTMLElement, entryOf: (wrap: HTMLElement) => RowEntry | undefined): void {
  const find = (target: EventTarget | null) => {
    const el = target instanceof Element ? target : null;
    const wrap = el?.closest<HTMLElement>('.row-wrap');
    if (!wrap || !container.contains(wrap)) return null;
    const entry = entryOf(wrap);
    return entry ? { el: el!, wrap, entry } : null;
  };

  // Set by a long press: the click that follows the finger lifting is not a tap.
  let swallowClick = false;
  container.addEventListener('click', (event) => {
    const hit = find(event.target);
    if (!hit) return;
    if (hit.el.closest('.row-more')) {
      event.stopPropagation();
      hit.entry.onMore();
      return;
    }
    if (!hit.el.closest('.row')) return;
    if (swallowClick) {
      swallowClick = false;
      return;
    }
    const pending = hit.entry.onOpen();
    if (!pending) return;
    const wrap = hit.wrap;
    wrap.classList.add('pending');
    void Promise.resolve(pending)
      .catch(() => undefined)
      .finally(() => wrap.classList.remove('pending'));
  });

  // A long press — iOS Safari fires no `contextmenu` for one — or a right click opens the actions.
  let timer: number | undefined;
  let pressed: HTMLElement | null = null;
  let startX = 0;
  let startY = 0;
  let openedAt = 0;
  const openMenu = (entry: RowEntry) => {
    if (Date.now() - openedAt < MENU_DEBOUNCE_MS) return;
    openedAt = Date.now();
    entry.onMore();
  };
  const cancel = () => {
    window.clearTimeout(timer);
    timer = undefined;
    pressed?.classList.remove('pressing');
    pressed = null;
  };
  container.addEventListener(
    'touchstart',
    (event) => {
      cancel();
      swallowClick = false;
      const touch = event.touches[0];
      const hit = find(event.target);
      if (event.touches.length !== 1 || !touch || !hit?.entry.contextMenu || !hit.el.closest('.row')) return;
      const row = hit.el.closest<HTMLElement>('.row')!;
      startX = touch.clientX;
      startY = touch.clientY;
      pressed = row;
      row.classList.add('pressing');
      timer = window.setTimeout(() => {
        cancel();
        haptic('medium');
        swallowClick = true;
        openMenu(hit.entry);
      }, LONG_PRESS_MS);
    },
    { passive: true }
  );
  container.addEventListener(
    'touchmove',
    (event) => {
      const touch = event.touches[0];
      if (!touch || timer === undefined) return;
      if (Math.hypot(touch.clientX - startX, touch.clientY - startY) > LONG_PRESS_SLOP_PX) cancel();
    },
    { passive: true }
  );
  container.addEventListener('touchend', cancel);
  container.addEventListener('touchcancel', cancel);
  container.addEventListener('contextmenu', (event) => {
    const hit = find(event.target);
    if (!hit?.entry.contextMenu || !hit.el.closest('.row')) return;
    event.preventDefault();
    cancel();
    openMenu(hit.entry);
  });
}
