import type { AppContext } from '../../app/context';
import type { BrowseItem, LibraryScope, PlayContext } from '../../api/types';
import { errorMessage } from '../../core/errors';
import { songs } from '../../core/format';
import { escapeAttr, escapeHtml, required } from '../../core/html';
import type { AppState, LibraryState, ReorderTarget } from '../../state/appState';
import { isDragging, paintReorderList, type ReorderEntry } from '../components/reorderList';
import { icons } from '../icons';
import { showToast } from '../overlay';
import { CATALOGUE_SCOPES } from './catalogueScopes';
import {
  collectionOf,
  paintLoadError,
  paintMediaList,
  paintPlaceholders,
  pickablesIn,
  syncTicks,
} from './mediaList';
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

/**
 * What Reorder works on here: the playlists (their top level, no search) or the open playlist's
 * songs. Null where nothing can be put in order.
 */
function reorderTargetOf(library: LibraryState): ReorderTarget | null {
  if (library.scope !== 'playlists' || library.query.trim()) return null;
  return library.playlist ? `playlist:${library.playlist.id}` : 'playlists';
}

/** The rows Reorder shows for the items on screen. */
function reorderEntries(items: BrowseItem[], target: ReorderTarget): ReorderEntry[] {
  if (target === 'playlists') {
    return items
      .filter((item) => item.id && !item.cataloguePath)
      .map((item) => ({
        key: item.id!,
        title: String(item.name ?? item.title ?? 'Playlist'),
        subtitle: songs(Number(item.trackCount ?? 0)),
        kind: 'playlist' as const,
      }));
  }
  return items
    .filter((item) => item.cataloguePath)
    .map((item) => ({
      key: item.cataloguePath!,
      title: item.title || item.name || 'Track',
      subtitle: [item.artist, item.album].filter(Boolean).join(' · '),
      kind: 'track' as const,
    }));
}

/** What the header shows: one key per top level or drill. */
function headKey(library: LibraryState): string {
  return JSON.stringify([library.scope, library.folderPath, library.album?.id, library.artist, library.playlist?.id]);
}

/**
 * Catalogue: Dirs · Albums · Artists · Playlists. The scopes and the search field stay on every level
 * (as in the Mac and iOS remotes): typing searches from the top level, the clear button goes back
 * to it. The field is never rebuilt while it is used, so the keyboard stays up.
 */
export class LibraryView implements View {
  private unsubscribe: (() => void) | null = null;
  private root: HTMLElement | null = null;
  /** A search from this field is under way: the header follows it (it may leave a folder). */
  private searching = false;

  constructor(private readonly ctx: AppContext) {}

  render(root: HTMLElement, host: ViewHost): void {
    this.dispose();
    this.root = root;
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
        <div class="search-row">
          <div class="search-wrap">
            ${icons.search}
            <input id="search" type="search" enterkeyhint="search" autocomplete="off" spellcheck="false"
              placeholder="${escapeAttr(placeholderOf(library))}" value="${escapeAttr(library.query)}" />
            <button type="button" class="search-clear" aria-label="Clear search" ${library.query ? '' : 'hidden'}>${icons.clear}</button>
          </div>
          <button type="button" class="search-side" data-mode></button>
        </div>
        <div class="list-tools" data-listtools hidden></div>
        <div class="pick-bar" data-pickbar hidden></div>
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
    const pickBar = required(root, '[data-pickbar]');
    // Select sits beside the search on a desktop and in the title row on a phone; the title row
    // is painted again as the level changes, so its click is caught here.
    required(root, '.search-side').addEventListener('click', () => this.toggleMode());
    head.addEventListener('click', (event) => {
      if (event.target instanceof Element && event.target.closest('[data-mode]')) this.toggleMode();
    });
    this.paintMode(pickBar, list);
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
      const modeChanged =
        state.picks.selecting !== previous.picks.selecting ||
        state.reorder !== previous.reorder ||
        headKey(now) !== headKey(before) ||
        now.query !== before.query;
      if (!modeChanged && state.collections.playlists !== previous.collections.playlists) {
        // Export All is offered once a playlist holds a song.
        this.paintMode(pickBar, list);
      }
      if (modeChanged) {
        this.paintMode(pickBar, list);
        // Reorder or Select coming or going: the path bar's Reorder and the rows follow.
        if (state.reorder !== previous.reorder || state.picks.selecting !== previous.picks.selecting) {
          this.paintHead(head, host);
        }
      } else if (
        now.items.length !== before.items.length &&
        reorderTargetOf(now)?.startsWith('playlist:') &&
        !this.searching
      ) {
        // An open playlist's songs arrived: Reorder shows once there are two to put in order.
        this.paintHead(head, host);
      }
      if (
        modeChanged ||
        now.items !== before.items ||
        now.loading !== before.loading ||
        now.error !== before.error
      ) {
        // A drag keeps its rows: they already show the order it makes.
        if (!(state.reorder && isDragging(list) && now.items !== before.items && !modeChanged)) this.paintList(root, list);
      } else if (state.picks.tracks !== previous.picks.tracks) {
        syncTicks(list, this.ctx);
        this.paintPickBar(pickBar, list);
      }
    });
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Select / Done, the playlists' tools and the selection bar, as the screen stands. */
  private paintMode(pickBar: HTMLElement, list: HTMLElement): void {
    const state = this.ctx.store.get();
    const target = reorderTargetOf(state.library);
    const reordering = target !== null && state.reorder === target;
    const playlistsTop = target === 'playlists' && !state.picks.selecting;
    this.paintSelectButtons();
    this.paintListTools(playlistsTop, reordering);
    this.paintPickBar(pickBar, list);
  }

  /**
   * Select / Done — beside the search (desktop) and in the title row (phone). Hidden while a list
   * is reordered, and on the playlists' top level, which lists no songs and has its own tools.
   */
  private paintSelectButtons(): void {
    const state = this.ctx.store.get();
    const target = reorderTargetOf(state.library);
    const selecting = state.picks.selecting;
    const hidden = (target !== null && state.reorder === target) || (target === 'playlists' && !selecting);
    this.root?.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => {
      button.textContent = selecting ? 'Done' : 'Select';
      button.hidden = hidden;
      button.classList.toggle('on', selecting);
      button.setAttribute(
        'aria-label',
        selecting ? 'Stop selecting songs' : 'Select songs to add them to a playlist, label them, or take them out'
      );
    });
  }

  private toggleMode(): void {
    if (this.ctx.picks.state.selecting) this.ctx.picks.end();
    else this.ctx.picks.start();
  }

  /** On the playlists' top level: Reorder / Done, and Export All. */
  private paintListTools(show: boolean, reordering: boolean): void {
    const tools = this.root?.querySelector<HTMLElement>('[data-listtools]');
    if (!tools) return;
    const playlists = this.ctx.store.get().collections.playlists;
    tools.hidden = !show;
    if (!show) {
      tools.innerHTML = '';
      return;
    }
    const canExport = playlists.some((p) => p.trackCount > 0);
    tools.innerHTML = `
      <button type="button" class="group-action${reordering ? ' on' : ''}" data-reorder aria-pressed="${reordering}">${
        reordering ? 'Done' : 'Reorder'
      }</button>
      ${
        reordering
          ? '<span class="list-tools-note">Drag ≡ to put them in order</span>'
          : `<button type="button" class="group-action" data-export ${canExport ? '' : 'disabled'}
              title="Every playlist as an M3U8 file, into a folder on the host">Export All…</button>`
      }`;
    tools.querySelector('[data-reorder]')?.addEventListener('click', () =>
      this.ctx.store.update((state) => ({ reorder: state.reorder === 'playlists' ? null : 'playlists' }))
    );
    tools.querySelector('[data-export]')?.addEventListener('click', () => this.ctx.actions.exportPlaylists());
  }

  /**
   * While selecting: how many are ticked, Select All, Clear, then what to do with them — Remove
   * (inside a playlist), Labels, Add to Playlist.
   */
  private paintPickBar(bar: HTMLElement, list: HTMLElement): void {
    const { selecting, tracks } = this.ctx.store.get().picks;
    bar.hidden = !selecting;
    if (!selecting) {
      bar.innerHTML = '';
      return;
    }
    const listed = pickablesIn(list);
    const playlist = collectionOf({ kind: 'library', library: this.ctx.store.get().library });
    // Remove takes out the ticked songs this playlist lists; ticks made elsewhere stay out of it.
    const shown = new Set(listed.map((t) => t.cataloguePath));
    const removable = tracks.filter((t) => shown.has(t.cataloguePath)).map((t) => t.cataloguePath);
    bar.innerHTML = `
      <div class="pick-text">
        <p class="pick-count">${tracks.length ? `${songs(tracks.length)} selected` : 'Tap songs to tick them'}</p>
        <div class="pick-links">
          <button type="button" data-pick-all ${listed.length ? '' : 'disabled'}>Select All</button>
          <button type="button" data-pick-clear ${tracks.length ? '' : 'disabled'}>Clear</button>
        </div>
      </div>
      <div class="pick-actions">
        ${
          playlist
            ? `<button type="button" class="pick-act danger" data-pick-remove ${removable.length ? '' : 'disabled'}
                title="Take the ticked songs out of this playlist — the files stay where they are">Remove</button>`
            : ''
        }
        <button type="button" class="pick-act" data-pick-labels ${tracks.length ? '' : 'disabled'}
          title="Put a label on the ticked songs, or take one off">Labels</button>
        <button type="button" class="pick-add" data-pick-add ${tracks.length ? '' : 'disabled'}>
          ${icons.macList}<span>Add to Playlist</span>
        </button>
      </div>`;
    bar.querySelector('[data-pick-all]')?.addEventListener('click', () => this.ctx.picks.select(pickablesIn(list)));
    bar.querySelector('[data-pick-clear]')?.addEventListener('click', () => this.ctx.picks.clear());
    bar.querySelector('[data-pick-add]')?.addEventListener('click', () => this.ctx.actions.addPicksToPlaylist());
    bar.querySelector('[data-pick-labels]')?.addEventListener('click', () => this.ctx.actions.labelPicks());
    bar.querySelector('[data-pick-remove]')?.addEventListener('click', () => {
      if (playlist) void this.ctx.actions.removePicks(playlist, removable);
    });
  }

  /** A drop in Reorder: the new order shows at once and goes to the host. */
  private async moved(target: ReorderTarget, keys: string[]): Promise<void> {
    const library = this.ctx.store.get().library;
    const byKey = new Map(library.items.map((item) => [target === 'playlists' ? item.id : item.cataloguePath, item]));
    const items = keys.map((key) => byKey.get(key)).filter((item): item is BrowseItem => Boolean(item));
    if (items.length === library.items.length) {
      this.ctx.store.update((state) => ({ library: { ...state.library, items } }));
    }
    try {
      if (target === 'playlists') await this.ctx.collections.reorderPlaylists(keys);
      else await this.ctx.collections.reorderPlaylistTracks(target.slice('playlist:'.length), keys);
    } catch (err) {
      showToast(errorMessage(err, 'Could not save the order'), { error: true });
      await this.ctx.nav.refresh();
    }
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
      <div class="page-header phone-quiet">
        <div class="page-title-block">
          <h1 class="large-title">Catalogue</h1>
          <p class="page-sub">${escapeHtml(scope.long)}${files ? ` — ${files} files indexed.` : ''}</p>
        </div>
        ${host.headerPlayerSlot()}
        <button type="button" class="head-action" data-mode></button>
      </div>`;
    this.paintSelectButtons();
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
      ${this.pathReorderHtml(library)}
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
    bar.querySelector('[data-path-reorder]')?.addEventListener('click', () => {
      const target = reorderTargetOf(this.ctx.store.get().library);
      this.ctx.store.update((state) => ({ reorder: state.reorder ? null : target }));
    });
  }

  /** Reorder / Done for an open playlist's songs (not while selecting). */
  private pathReorderHtml(library: LibraryState): string {
    const state: AppState = this.ctx.store.get();
    const target = reorderTargetOf(library);
    if (!target || target === 'playlists' || state.picks.selecting || library.items.length < 2) return '';
    const on = state.reorder === target;
    return `<button type="button" class="path-reorder${on ? ' on' : ''}" data-path-reorder aria-pressed="${on}">${
      on ? 'Done' : 'Reorder'
    }</button>`;
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
    const state = this.ctx.store.get();
    const target = reorderTargetOf(library);
    list.classList.remove('reorder-list');
    if (target && state.reorder === target) {
      paintReorderList(list, reorderEntries(library.items, target), (keys) => this.moved(target, keys));
    } else {
      paintMediaList(list, library.items, { kind: 'library', library }, this.ctx);
    }
    const pickBar = root.querySelector<HTMLElement>('[data-pickbar]');
    if (pickBar && state.picks.selecting) this.paintPickBar(pickBar, list);
  }
}
