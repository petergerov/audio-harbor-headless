import type { AppContext } from '../../app/context';
import type { LibraryScope, PlayContext } from '../../api/types';
import { escapeAttr, escapeHtml, required } from '../../core/html';
import type { LibraryState } from '../../state/appState';
import { icons } from '../icons';
import { paintMediaList } from './mediaList';
import type { View, ViewHost } from './view';

const SEARCH_DEBOUNCE_MS = 220;

const SCOPES: Array<{ scope: LibraryScope; label: string }> = [
  { scope: 'albums', label: 'Albums' },
  { scope: 'artists', label: 'Artists' },
  { scope: 'folders', label: 'Folders' },
];

/** Where the library is browsed into: title, back link and what Play queues. */
interface Drill {
  title: string;
  back: string;
  play: PlayContext;
  subtitle?: string;
}

function drillOf(library: LibraryState): Drill | null {
  if (library.scope === 'folders' && library.folderPath) {
    return {
      title: library.folderPath.split(/[/\\]/).filter(Boolean).pop() ?? 'Folders',
      back: '‹ Folders',
      play: { folder: library.folderPath },
    };
  }
  if (library.scope === 'albums' && library.album) {
    return {
      title: library.album.title,
      back: '‹ Albums',
      play: { albumId: library.album.id },
      subtitle: library.album.artist,
    };
  }
  if (library.scope === 'artists' && library.artist) {
    return { title: library.artist, back: '‹ Artists', play: { artist: library.artist } };
  }
  return null;
}

/** Albums, artists and folders, drilled into or searched. */
export class LibraryView implements View {
  constructor(private readonly ctx: AppContext) {}

  render(root: HTMLElement, host: ViewHost): void {
    const library = this.ctx.store.get().library;
    const drill = drillOf(library);
    root.innerHTML = `
      ${
        drill
          ? `<div class="nav-row">
              <button type="button" class="nav-link" data-back>${drill.back}</button>
              <button type="button" class="nav-link accent" data-play-all ${library.items.length ? '' : 'disabled'}>Play</button>
            </div>`
          : ''
      }
      <div class="page-header">
        ${
          drill
            ? `<h3 class="drill-title">${escapeHtml(drill.title)}</h3>`
            : `<h1 class="large-title">Catalogue</h1>`
        }
        ${host.headerPlayerSlot()}
      </div>
      ${drill?.subtitle ? `<p class="drill-sub">${escapeHtml(drill.subtitle)}</p>` : ''}
      ${drill ? '' : this.browseControls(library)}
      <div id="list" class="group"></div>
    `;

    root.querySelectorAll<HTMLElement>('[data-scope]').forEach((button) => {
      button.addEventListener('click', () => void this.ctx.nav.setLibraryScope(button.dataset.scope as LibraryScope));
    });
    root.querySelector('[data-back]')?.addEventListener('click', () => void this.ctx.nav.back());
    if (drill) root.querySelector('[data-play-all]')?.addEventListener('click', () => void this.ctx.actions.play(drill.play));

    const list = required(root, '#list');
    const search = root.querySelector<HTMLInputElement>('#search');
    if (search) {
      let debounce: number | undefined;
      search.addEventListener('input', () => {
        window.clearTimeout(debounce);
        debounce = window.setTimeout(async () => {
          await this.ctx.nav.search(search.value);
          this.paintList(list);
        }, SEARCH_DEBOUNCE_MS);
      });
    }
    this.paintList(list);
  }

  private browseControls(library: LibraryState): string {
    return `
      <div class="segmented">
        ${SCOPES.map(
          (s) =>
            `<button type="button" data-scope="${s.scope}" class="${library.scope === s.scope ? 'active' : ''}">${s.label}</button>`
        ).join('')}
      </div>
      <div class="search-wrap">
        ${icons.search}
        <input id="search" type="search" enterkeyhint="search" placeholder="Songs, albums, artists"
          value="${escapeAttr(library.query)}" />
      </div>`;
  }

  private paintList(list: HTMLElement): void {
    const library = this.ctx.store.get().library;
    paintMediaList(list, library.items, { kind: 'library', library }, this.ctx);
  }
}
