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
      play: { folder: library.folderPath },
    };
  }
  if (library.scope === 'albums' && library.album) {
    return {
      title: library.album.title,
      play: { albumId: library.album.id },
      subtitle: library.album.artist,
    };
  }
  if (library.scope === 'artists' && library.artist) {
    return { title: library.artist, play: { artist: library.artist } };
  }
  if (library.scope === 'playlists' && library.playlist) {
    return {
      title: library.playlist.name,
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
      <div class="screen-top">
        <div data-head></div>
        <div class="segmented" data-scopes>
          ${CATALOGUE_SCOPES.map(
            (s) =>
              `<button type="button" data-scope="${s.scope}" class="${library.scope === s.scope ? 'active' : ''}"><span class="seg-short">${s.label}</span><span class="seg-long">${s.long}</span></button>`
          ).join('')}
        </div>
        <div class="search-wrap">
          ${icons.search}
          <input id="search" type="search" enterkeyhint="search" autocomplete="off" spellcheck="false"
            placeholder="${escapeAttr(placeholderOf(library))}" value="${escapeAttr(library.query)}" />
          <button type="button" class="search-clear" aria-label="Clear search" ${library.query ? '' : 'hidden'}>${icons.clear}</button>
        </div>
        <div class="path-bar" data-pathbar hidden></div>
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

  /**
   * The screen's title stays on every level; where you are shows in the path bar under the search
   * (both layouts), as in the Mac catalogue.
   */
  private paintHead(head: HTMLElement, host: ViewHost): void {
    const library = this.ctx.store.get().library;
    const drill = drillOf(library);
    const pathBar = head.parentElement?.querySelector<HTMLElement>('[data-pathbar]') ?? null;
    if (pathBar) {
      if (drill) this.paintPathBar(pathBar, library, drill);
      else {
        pathBar.hidden = true;
        pathBar.innerHTML = '';
      }
    }
    // "Albums — 263 files indexed.", as the Mac catalogue says it.
    const scope = CATALOGUE_SCOPES.find((s) => s.scope === library.scope) ?? CATALOGUE_SCOPES[0]!;
    const files = this.ctx.store.get().scan?.lastScan?.scanned;
    head.innerHTML = `
      <div class="page-header phone-untitled">
        <div class="page-title-block">
          <h1 class="large-title">Catalogue</h1>
          <p class="page-sub">${escapeHtml(scope.long)}${files ? ` — ${files} files indexed.` : ''}</p>
        </div>
        ${host.headerPlayerSlot()}
      </div>`;
  }

  /**
   * The Mac catalogue's path bar: Up (a step back), a hairline, Home (the scope's top: all
   * library folders, all albums …), then the path — every folder above the open one is a link
   * there, the open one is plain. Play all at the end.
   */
  private paintPathBar(bar: HTMLElement, library: LibraryState, drill: Drill): void {
    const name = (p: string) => p.split(/[/\\]/).filter(Boolean).pop() ?? p;
    const crumbs: Array<{ label: string; depth?: number }> =
      library.scope === 'folders' && library.folderPath
        ? [...library.folderStack, library.folderPath].map((p, depth) => ({ label: name(p), depth }))
        : [{ label: drill.subtitle ? `${drill.title} · ${drill.subtitle}` : drill.title }];
    const last = crumbs.length - 1;
    const scope = CATALOGUE_SCOPES.find((s) => s.scope === library.scope) ?? CATALOGUE_SCOPES[0]!;
    const homeLabel = library.scope === 'folders' ? 'All library folders' : `All ${scope.long.toLowerCase()}`;
    const sep = `<span class="path-sep" aria-hidden="true">${icons.chevron}</span>`;
    bar.hidden = false;
    bar.innerHTML = `
      <button type="button" class="path-up" data-back>${icons.chevronLeft}<span>Up</span></button>
      <span class="path-rule" aria-hidden="true"></span>
      <button type="button" class="path-home" data-home aria-label="${escapeAttr(homeLabel)}" title="${escapeAttr(homeLabel)}">${icons.home}</button>
      <nav class="path-crumbs" aria-label="Where">
        ${crumbs
          .map((c, i) =>
            i === last
              ? `${sep}<span class="path-crumb current" aria-current="location">${escapeHtml(c.label)}</span>`
              : `${sep}<button type="button" class="path-crumb" data-depth="${c.depth}">${escapeHtml(c.label)}</button>`
          )
          .join('')}
      </nav>
      <button type="button" class="path-play" data-play-all aria-label="Play all" title="Play all" ${library.items.length ? '' : 'disabled'}>
        <span class="path-play-key">${icons.trailPlay}</span>
      </button>`;
    // The open folder in view at the end of a long path.
    const crumbsEl = bar.querySelector<HTMLElement>('.path-crumbs');
    if (crumbsEl) crumbsEl.scrollLeft = crumbsEl.scrollWidth;
    bar.querySelector('[data-back]')?.addEventListener('click', () => void this.ctx.nav.back());
    bar.querySelector('[data-home]')?.addEventListener('click', () => void this.ctx.nav.libraryHome());
    bar.querySelectorAll<HTMLElement>('[data-depth]').forEach((crumb) =>
      crumb.addEventListener('click', () => void this.ctx.nav.openFolderAt(Number(crumb.dataset.depth)))
    );
    bar.querySelector('[data-play-all]')?.addEventListener('click', () => void this.ctx.actions.play(drill.play));
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
