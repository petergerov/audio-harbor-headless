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
}

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

/** A tappable row with a `···` button beside it. */
export function mediaRow(options: {
  row: RowModel;
  covers: Covers;
  onOpen: () => void;
  onMore: () => void;
  moreLabel: string;
  /** Track rows: the path marks the playing one and a long press / right click opens `onMore`. */
  path?: string;
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
  if (options.row.playing) {
    wrap.classList.add('playing');
    open.classList.add('playing');
  }
  open.addEventListener('click', () => options.onOpen());
  more.addEventListener('click', (event) => {
    event.stopPropagation();
    options.onMore();
  });
  if (options.contextMenu) {
    open.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      options.onMore();
    });
  }
  wrap.append(open, more);
  return wrap;
}
