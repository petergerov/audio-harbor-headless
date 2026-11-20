import type { AppContext } from '../../app/context';
import type { CollectionKind } from '../../api/types';
import { initial, songs } from '../../core/format';
import { escapeHtml, required } from '../../core/html';
import type { OpenCollection } from '../../state/appState';
import { paintRows } from '../components/mediaRow';
import { icons } from '../icons';
import { showToast } from '../overlay';
import { paintLoadError, paintMediaList, paintPlaceholders, pickablesIn, syncTicks } from './mediaList';
import type { View, ViewHost } from './view';

/** Playlists and labels: the overview, or the one that is open. */
export class CollectionsView implements View {
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly ctx: AppContext) {}

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    // The ticks belong to the list they were made in.
    if (this.ctx.picks.state.selecting) this.ctx.picks.end();
  }

  /**
   * Paints what the store holds at once — the navigator loads the open one's tracks — and
   * repaints when they arrive or change behind the screen (a drive or share came or went).
   */
  render(root: HTMLElement, host: ViewHost): void {
    this.dispose();
    this.paint(root, host);
    this.unsubscribe = this.ctx.store.subscribe((state, previous) => {
      const now = state.collections;
      const before = previous.collections;
      if (!root.isConnected || state.tab !== 'collections') return;
      if (now.open?.kind !== before.open?.kind || now.open?.id !== before.open?.id) {
        // Another one opened: the ticks stay with the one they were made in.
        if (state.picks.selecting) this.ctx.picks.end();
      }
      const changed = now.open
        ? now.open !== before.open ||
          now.items !== before.items ||
          now.loading !== before.loading ||
          now.error !== before.error ||
          state.picks.selecting !== previous.picks.selecting
        : now.open !== before.open || now.playlists !== before.playlists || now.labels !== before.labels;
      if (changed) this.paint(root, host);
      else if (now.open && state.picks.tracks !== previous.picks.tracks) {
        const list = root.querySelector<HTMLElement>('[data-list]');
        const bar = root.querySelector<HTMLElement>('[data-pickbar]');
        if (list) syncTicks(list, this.ctx);
        if (list && bar) this.paintPickBar(bar, list, now.open);
      }
    });
  }

  private paint(root: HTMLElement, host: ViewHost): void {
    const open = this.ctx.store.get().collections.open;
    if (open) this.renderDetail(root, host, open);
    else this.renderOverview(root, host);
  }

  private renderOverview(root: HTMLElement, host: ViewHost): void {
    const { playlists, labels } = this.ctx.store.get().collections;
    root.innerHTML = `
      <div class="nav-row">
        <span></span>
        <button type="button" class="nav-link accent" data-new-playlist>New Playlist</button>
      </div>
      <div class="page-header">
        <h1 class="large-title">Playlists</h1>
        ${host.headerPlayerSlot()}
      </div>
      <p class="group-label">Playlists</p>
      <div class="group" data-playlists></div>
      <p class="group-label">Labels</p>
      <div class="group" data-labels></div>
    `;
    root.querySelector('[data-new-playlist]')?.addEventListener('click', () => this.ctx.actions.createPlaylist());
    this.fillGroup(
      required(root, '[data-playlists]'),
      'playlist',
      playlists.map((p) => ({ id: p.id, name: p.name, count: p.trackCount })),
      `<div class="empty"><strong>No Playlists</strong>Collect albums, artists, or songs for later.</div>`
    );
    this.fillGroup(
      required(root, '[data-labels]'),
      'label',
      labels.map((l) => ({ id: l.name, name: l.name, count: l.trackCount })),
      `<div class="empty"><strong>No Labels</strong>Tag music with Add → Labels on any item.</div>`
    );
  }

  private fillGroup(
    group: HTMLElement,
    kind: CollectionKind,
    entries: Array<{ id: string; name: string; count: number }>,
    empty: string
  ): void {
    if (!entries.length) {
      group.innerHTML = empty;
      return;
    }
    paintRows(
      group,
      entries.map((entry) => {
        const count = Number(entry.count ?? 0);
        return {
          row: { kind, title: entry.name, subtitle: count === 0 ? 'Empty' : songs(count), chevron: true },
          moreLabel: 'More',
          onOpen: () => void this.ctx.nav.openCollection(kind, entry.id, entry.name),
          onMore: () => this.ctx.actions.manageCollection(kind, entry.id, entry.name),
        };
      }),
      this.ctx.covers
    );
  }

  private renderDetail(root: HTMLElement, host: ViewHost, open: OpenCollection): void {
    const { items, loading, error } = this.ctx.store.get().collections;
    const count = items.length;
    const cover = items.find((t) => t.artworkHash)?.artworkHash ?? null;
    const isPlaylist = open.kind === 'playlist';
    const selecting = this.ctx.picks.state.selecting;
    root.innerHTML = `
      <div class="nav-row">
        <button type="button" class="nav-link" data-back>‹ Catalogue</button>
        ${host.headerPlayerSlot()}
        <button type="button" class="nav-link" data-manage aria-label="Options">Edit</button>
      </div>
      <header class="collection-hero">
        <div class="collection-mosaic ${open.kind} ${cover ? 'has-art' : ''}" aria-hidden="true">
          ${cover ? this.ctx.covers.html(cover, open.title) : `<span>${escapeHtml(initial(open.title, 'P'))}</span>`}
        </div>
        <div class="collection-hero-text">
          <p class="collection-kind">${isPlaylist ? 'Playlist' : 'Label'}</p>
          <h1 class="collection-title">${escapeHtml(open.title)}</h1>
          <p class="collection-meta">${count === 0 ? (loading ? '&nbsp;' : 'No songs') : songs(count)}</p>
          <div class="collection-actions">
            <button type="button" class="pill-btn primary" data-play-all ${count ? '' : 'disabled'}>${icons.playSm}<span>Play</span></button>
            ${
              isPlaylist
                ? `<button type="button" class="pill-btn" data-add-music><span aria-hidden="true">+</span><span>Add Music</span></button>`
                : ''
            }
            <button type="button" class="pill-btn${selecting ? ' on' : ''}" data-select ${count || selecting ? '' : 'disabled'}
              aria-pressed="${selecting}"
              title="${selecting ? 'Stop selecting' : 'Tick several songs to take them out together'}">${selecting ? 'Done' : 'Select'}</button>
          </div>
        </div>
      </header>
      <div class="pick-bar" data-pickbar hidden></div>
      <div class="group" data-list></div>
    `;

    root.querySelector('[data-back]')?.addEventListener('click', () => this.ctx.nav.closeCollection());
    root.querySelector('[data-manage]')?.addEventListener('click', () =>
      this.ctx.actions.manageCollection(open.kind, open.id, open.title)
    );
    root.querySelector('[data-play-all]')?.addEventListener('click', () => {
      void this.ctx.actions.play(isPlaylist ? { playlistId: open.id } : { label: open.id });
    });
    root.querySelector('[data-add-music]')?.addEventListener('click', () => {
      void this.ctx.nav.goTo('library');
      showToast('Pick music in Catalogue, then use Add');
    });
    root.querySelector('[data-select]')?.addEventListener('click', () => {
      if (this.ctx.picks.state.selecting) this.ctx.picks.end();
      else this.ctx.picks.start();
    });
    this.ctx.covers.hydrate(root);
    const list = required(root, '[data-list]');
    if (!count && loading) paintPlaceholders(list);
    else if (!count && error) paintLoadError(list, error, () => void this.ctx.nav.refresh());
    else paintMediaList(list, items, { kind: 'collection', collection: open }, this.ctx);
    this.paintPickBar(required(root, '[data-pickbar]'), list, open);
  }

  /** While selecting: how many are ticked, Select All, Clear and Remove Label / Remove from Playlist. */
  private paintPickBar(bar: HTMLElement, list: HTMLElement, open: OpenCollection): void {
    const { selecting, tracks } = this.ctx.store.get().picks;
    bar.hidden = !selecting;
    if (!selecting) {
      bar.innerHTML = '';
      return;
    }
    const listed = pickablesIn(list);
    const isLabel = open.kind === 'label';
    bar.innerHTML = `
      <div class="pick-text">
        <p class="pick-count">${tracks.length ? `${songs(tracks.length)} selected` : 'Tap songs to tick them'}</p>
        <div class="pick-links">
          <button type="button" data-pick-all ${listed.length ? '' : 'disabled'}>Select All</button>
          <button type="button" data-pick-clear ${tracks.length ? '' : 'disabled'}>Clear</button>
        </div>
      </div>
      <div class="pick-actions">
        <button type="button" class="pick-act danger" data-pick-remove ${tracks.length ? '' : 'disabled'}
          title="${isLabel ? 'Take this label off the ticked songs' : 'Take the ticked songs out of this playlist'} — the files stay where they are">${
            isLabel ? 'Remove Label' : 'Remove from Playlist'
          }</button>
      </div>`;
    bar.querySelector('[data-pick-all]')?.addEventListener('click', () => this.ctx.picks.select(pickablesIn(list)));
    bar.querySelector('[data-pick-clear]')?.addEventListener('click', () => this.ctx.picks.clear());
    bar.querySelector('[data-pick-remove]')?.addEventListener('click', () => {
      void this.ctx.actions.removePicks(
        open,
        this.ctx.store.get().picks.tracks.map((t) => t.cataloguePath)
      );
    });
  }
}
