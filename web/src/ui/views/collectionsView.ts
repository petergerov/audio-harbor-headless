import type { AppContext } from '../../app/context';
import type { CollectionKind } from '../../api/types';
import { initial, songs } from '../../core/format';
import { escapeHtml, required } from '../../core/html';
import type { OpenCollection } from '../../state/appState';
import { mediaRow } from '../components/mediaRow';
import { icons } from '../icons';
import { showToast } from '../overlay';
import { paintMediaList } from './mediaList';
import type { View, ViewHost } from './view';

/** Playlists and labels: the overview, or the one that is open. */
export class CollectionsView implements View {
  constructor(private readonly ctx: AppContext) {}

  async render(root: HTMLElement, host: ViewHost): Promise<void> {
    await this.ctx.collections.refresh();
    if (this.ctx.store.get().collections.open) {
      await this.ctx.collections.loadOpen();
      const open = this.ctx.store.get().collections.open;
      if (open) {
        this.renderDetail(root, host, open);
        return;
      }
    }
    this.renderOverview(root, host);
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
    for (const entry of entries) {
      const count = Number(entry.count ?? 0);
      group.appendChild(
        mediaRow({
          row: { kind, title: entry.name, subtitle: count === 0 ? 'Empty' : songs(count), chevron: true },
          covers: this.ctx.covers,
          moreLabel: 'More',
          onOpen: () => void this.ctx.nav.openCollection(kind, entry.id, entry.name),
          onMore: () => this.ctx.actions.manageCollection(kind, entry.id, entry.name),
        })
      );
    }
  }

  private renderDetail(root: HTMLElement, host: ViewHost, open: OpenCollection): void {
    const items = this.ctx.store.get().collections.items;
    const count = items.length;
    const cover = items.find((t) => t.artworkHash)?.artworkHash ?? null;
    const isPlaylist = open.kind === 'playlist';
    root.innerHTML = `
      <div class="nav-row">
        <button type="button" class="nav-link" data-back>‹ Playlists</button>
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
          <p class="collection-meta">${count === 0 ? 'No songs' : songs(count)}</p>
          <div class="collection-actions ${isPlaylist ? '' : 'single'}">
            <button type="button" class="pill-btn primary" data-play-all ${count ? '' : 'disabled'}>${icons.playSm}<span>Play</span></button>
            ${
              isPlaylist
                ? `<button type="button" class="pill-btn" data-add-music><span aria-hidden="true">+</span><span>Add Music</span></button>`
                : ''
            }
          </div>
        </div>
      </header>
      <div class="group" data-list></div>
    `;

    root.querySelector('[data-back]')?.addEventListener('click', () => this.ctx.nav.closeCollection());
    root.querySelector('[data-manage]')?.addEventListener('click', () =>
      this.ctx.actions.manageCollection(open.kind, open.id, open.title)
    );
    root.querySelector('[data-play-all]')?.addEventListener('click', () => {
      void this.ctx.actions.play(isPlaylist ? { playlistId: open.id } : { label: open.id });
    });
    root.querySelector('[data-add-music]')?.addEventListener('click', async () => {
      await this.ctx.nav.goTo('library');
      showToast('Pick music in Catalogue, then use Add');
    });
    this.ctx.covers.hydrate(root);
    paintMediaList(required(root, '[data-list]'), items, { kind: 'collection', collection: open }, this.ctx);
  }
}
