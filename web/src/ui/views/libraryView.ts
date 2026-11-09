import type { AppContext } from '../../app/context';
import type { LibraryScope, PlayContext } from '../../api/types';
import { escapeAttr, escapeHtml, required } from '../../core/html';
import type { LibraryState } from '../../state/appState';
import { icons } from '../icons';
import { CATALOGUE_SCOPES } from './catalogueScopes';
import { paintLoadError, paintMediaList, paintPlaceholders } from './mediaList';
import type { View, ViewHost } from './view';

const SEARCH_DEBOUNCE_MS = 250;

/** Where the library is browsed into: title, back link and what Play queues. */
interface Drill {
  title: string;
  back: string;
  play: PlayContext;
  subtitle?: string;
}

/** The search prompt of the scope on screen. */
function placeholderOf(library: LibraryState): string {
  return (CATALOGUE_SCOPES.find((s) => s.scope === library.scope) ?? CATALOGUE_SCOPES[0]!).search;
}

function drillOf(library: LibraryState): Drill | null {
  if (library.scope === 'folders' && library.folderPath) {
    return {
      title: library.folderPath.split(/[/\\]/).filter(Boolean).pop() ?? 'Dirs',
      back: '‹ Dirs',
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
  if (library.scope === 'playlists' && library.playlist) {
    return {
      title: library.playlist.name,
      back: '‹ Lists',
      play: { playlistId: library.playlist.id },
    };
  }
  return null;
}

/** What the header shows: one key per top level or drill. */
function headKey(library: LibraryState): string {
  return JSON.stringify([library.scope, library.folderPath, library.album?.id, library.artist, library.playlist?.id]);
}

/**
 * Catalogue: Dirs · Albums · Artists · Lists. The scopes and the search field stay on every level
 * (as in the Mac and iOS remotes): typing searches from the top level, the clear button goes back
 * to it. The field is never rebuilt while it is used, so the keyboard stays up.
 */
export class LibraryView implements View {
  private unsubscribe: (() => void) | null = null;
  /** A search from this field is under way: the header follows it (it may leave a folder). */
  private searching = false;

  constructor(private readonly ctx: AppContext) {}

  render(root: HTMLElement, host: ViewHost): void {
    this.dispose();
    const library = this.ctx.store.get().library;
    root.innerHTML = `
      <div data-head></div>
      <div class="segmented" data-scopes>
        ${CATALOGUE_SCOPES.map(
          (s) =>
            `<button type="button" data-scope="${s.scope}" class="${library.scope === s.scope ? 'active' : ''}">${s.label}</button>`
        ).join('')}
      </div>
      <div class="search-wrap">
        ${icons.search}
        <input id="search" type="search" enterkeyhint="search" autocomplete="off" spellcheck="false"
          placeholder="${escapeAttr(placeholderOf(library))}" value="${escapeAttr(library.query)}" />
        <button type="button" class="search-clear" aria-label="Clear search" ${library.query ? '' : 'hidden'}>${icons.clear}</button>
      </div>
      <div id="list" class="group"></div>
    `;
    const head = required(root, '[data-head]');
    this.paintHead(head, host);

    root.querySelectorAll<HTMLElement>('[data-scope]').forEach((button) => {
      button.addEventListener('click', () => void this.ctx.nav.setLibraryScope(button.dataset.scope as LibraryScope));
    });

    const search = required<HTMLInputElement>(root, '#search');
    const clear = required<HTMLButtonElement>(root, '.search-clear');
    let debounce: number | undefined;
    const run = (query: string) => {
      window.clearTimeout(debounce);
      this.searching = true;
      void this.ctx.nav.search(query).finally(() => {
        this.searching = false;
      });
    };
    search.addEventListener('input', () => {
      clear.hidden = !search.value;
      window.clearTimeout(debounce);
      // The new items repaint the list (below).
      debounce = window.setTimeout(() => run(search.value), SEARCH_DEBOUNCE_MS);
    });
    search.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      // Search now, and put the keyboard away to show the hits.
      run(search.value);
      search.blur();
    });
    // Clearing keeps the field focused (the keyboard stays) and shows the top level again.
    clear.addEventListener('pointerdown', (event) => event.preventDefault());
    clear.addEventListener('click', () => {
      search.value = '';
      clear.hidden = true;
      run('');
      search.focus({ preventScroll: true });
    });

    const list = required(root, '#list');
    this.paintList(root, list);
    // Items loaded behind the screen — the level arriving, a search, a scan that ended, a drive or
    // share that came or went — repaint the list; the scopes and the search field stay.
    this.unsubscribe = this.ctx.store.subscribe((state, previous) => {
      const now = state.library;
      const before = previous.library;
      if (!list.isConnected) return;
      // A search that left a folder: header, scope and prompt follow, the field stays as it is.
      if (this.searching && headKey(now) !== headKey(before)) {
        this.paintHead(head, host);
        search.placeholder = placeholderOf(now);
      }
      if (now.items !== before.items || now.loading !== before.loading || now.error !== before.error) {
        this.paintList(root, list);
      }
    });
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Back link, title and Play all inside an album, artist, folder or list; the large title at a top level. */
  private paintHead(head: HTMLElement, host: ViewHost): void {
    const library = this.ctx.store.get().library;
    const drill = drillOf(library);
    if (!drill) {
      head.innerHTML = `
        <div class="page-header">
          <h1 class="large-title">Catalogue</h1>
          ${host.headerPlayerSlot()}
        </div>`;
      return;
    }
    head.innerHTML = `
      <div class="nav-row">
        <button type="button" class="nav-link" data-back>${drill.back}</button>
        <button type="button" class="nav-link accent" data-play-all ${library.items.length ? '' : 'disabled'}>Play all</button>
      </div>
      <div class="page-header">
        <h3 class="drill-title">${escapeHtml(drill.title)}</h3>
        ${host.headerPlayerSlot()}
      </div>
      ${drill.subtitle ? `<p class="drill-sub">${escapeHtml(drill.subtitle)}</p>` : ''}`;
    head.querySelector('[data-back]')?.addEventListener('click', () => void this.ctx.nav.back());
    head.querySelector('[data-play-all]')?.addEventListener('click', () => void this.ctx.actions.play(drill.play));
  }

  private paintList(root: HTMLElement, list: HTMLElement): void {
    const library = this.ctx.store.get().library;
    const playAll = root.querySelector<HTMLButtonElement>('[data-play-all]');
    if (playAll) playAll.disabled = !library.items.length;
    if (!library.items.length && library.loading) {
      paintPlaceholders(list);
      return;
    }
    if (!library.items.length && library.error) {
      paintLoadError(list, library.error, () => void this.ctx.nav.refresh());
      return;
    }
    paintMediaList(list, library.items, { kind: 'library', library }, this.ctx);
  }
}
