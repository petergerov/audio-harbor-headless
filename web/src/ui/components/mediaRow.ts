import { haptic } from '../../core/device';
import { initial } from '../../core/format';
import { escapeHtml } from '../../core/html';
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
  artworkHash?: string | null;
  /** Small square cover (album rows). */
  thumb?: boolean;
  /** The track that plays now. */
  playing?: boolean;
  /** On a folder, drive or share that is not connected: greyed out, not playable. */
  unavailable?: boolean;
}

/** How long a press must last to open the row's actions, and how far the finger may drift. */
const LONG_PRESS_MS = 480;
const LONG_PRESS_SLOP_PX = 10;

export const PLAYING_GLYPH = `<span class="playing-glyph" aria-label="Now playing">${icons.speaker}</span>`;

function rowHtml(row: RowModel, covers: Covers): string {
  const thumb = row.thumb ? ' thumb' : '';
  const img = covers.img(row.artworkHash);
  const icon = img
    ? `<div class="row-icon ${row.kind}${thumb} has-art">${img}</div>`
    : `<div class="row-icon ${row.kind}${thumb}">${escapeHtml(initial(row.title))}</div>`;
  let trail = `<span class="row-trail"></span>`;
  if (row.playing) trail = `<span class="row-trail playing">${PLAYING_GLYPH}</span>`;
  else if (row.chevron) trail = `<span class="row-trail chevron">${icons.chevron}</span>`;
  return `
    ${icon}
    <div class="row-text">
      <div class="row-title">${escapeHtml(row.title)}</div>
      <div class="row-sub">${escapeHtml(row.subtitle)}</div>
    </div>
    ${trail}
  `;
}

/**
 * A tappable row with a `···` button beside it. When `onOpen` returns a promise (a track starting),
 * the row shows it is loading until the promise settles.
 */
export function mediaRow(options: {
  row: RowModel;
  covers: Covers;
  onOpen: () => void | Promise<unknown>;
  onMore: () => void;
  moreLabel: string;
  /** Track rows: the path marks the playing one. */
  path?: string;
  /** A long press (touch) or right click opens `onMore`. */
  contextMenu?: boolean;
}): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'row-wrap';
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'row has-icon';
  open.innerHTML = rowHtml(options.row, options.covers);
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'row-more';
  more.setAttribute('aria-label', options.moreLabel);
  more.innerHTML = `<span class="more-glyph">···</span>`;

  if (options.path) wrap.dataset.path = options.path;
  if (options.row.unavailable) {
    wrap.classList.add('unavailable');
    // Folders and albums still open (the catalogue shows them); a track does not play.
    if (options.row.kind === 'track') open.setAttribute('aria-disabled', 'true');
  }
  if (options.row.playing) {
    wrap.classList.add('playing');
    open.classList.add('playing');
  }
  // Set by a long press: the click that follows the finger lifting is not a tap.
  let swallowClick = false;
  open.addEventListener('click', () => {
    if (swallowClick) {
      swallowClick = false;
      return;
    }
    const pending = options.onOpen();
    if (!pending) return;
    wrap.classList.add('pending');
    void Promise.resolve(pending)
      .catch(() => undefined)
      .finally(() => wrap.classList.remove('pending'));
  });
  more.addEventListener('click', (event) => {
    event.stopPropagation();
    options.onMore();
  });
  if (options.contextMenu) bindLongPress(open, options.onMore, () => (swallowClick = true));
  wrap.append(open, more);
  return wrap;
}

/**
 * Opens the actions on a long press — iOS Safari fires no `contextmenu` for one — and on a right
 * click. Android fires both; the second within a moment is dropped.
 */
function bindLongPress(el: HTMLElement, onMore: () => void, swallowClick: () => void): void {
  let timer: number | undefined;
  let startX = 0;
  let startY = 0;
  let openedAt = 0;
  const openMenu = () => {
    if (Date.now() - openedAt < 800) return;
    openedAt = Date.now();
    onMore();
  };
  const cancel = () => {
    window.clearTimeout(timer);
    timer = undefined;
    el.classList.remove('pressing');
  };
  el.addEventListener(
    'touchstart',
    (event) => {
      const touch = event.touches[0];
      if (event.touches.length !== 1 || !touch) return;
      startX = touch.clientX;
      startY = touch.clientY;
      el.classList.add('pressing');
      timer = window.setTimeout(() => {
        cancel();
        haptic('medium');
        swallowClick();
        openMenu();
      }, LONG_PRESS_MS);
    },
    { passive: true }
  );
  el.addEventListener(
    'touchmove',
    (event) => {
      const touch = event.touches[0];
      if (!touch || timer === undefined) return;
      if (Math.hypot(touch.clientX - startX, touch.clientY - startY) > LONG_PRESS_SLOP_PX) cancel();
    },
    { passive: true }
  );
  el.addEventListener('touchend', cancel);
  el.addEventListener('touchcancel', cancel);
  el.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    cancel();
    openMenu();
  });
}
