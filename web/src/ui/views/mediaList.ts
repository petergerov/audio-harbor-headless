import type { AppContext } from '../../app/context';
import type { BrowseItem, PlayContext, Selection, Track } from '../../api/types';
import { haptic } from '../../core/device';
import { errorMessage } from '../../core/errors';
import { songs } from '../../core/format';
import type { LibraryState, OpenCollection } from '../../state/appState';
import { isCurrentTrack, nowPlayingPath } from '../../state/selectors';
import { mediaRow, type RowModel } from '../components/mediaRow';
import { showToast } from '../overlay';

/** Where a list shows: the library (browse or search), or an open playlist / label. */
export type ListScope =
  | { kind: 'library'; library: LibraryState }
  | { kind: 'collection'; collection: OpenCollection };

/** How one row looks and what it does. */
interface PresentedRow {
  row: RowModel;
  selection: Selection;
  open(): void;
  /** Track rows carry their path (playing mark, long press). */
  path?: string;
}

type Presenter = (item: BrowseItem, scope: ListScope, ctx: AppContext) => PresentedRow | null;

/** The library's top level of `scope`, no search: albums and artists list as entries. */
function listing(scope: ListScope, of: 'albums' | 'artists'): boolean {
  if (scope.kind !== 'library') return false;
  const library = scope.library;
  const drilled = of === 'albums' ? library.album : library.artist;
  return library.scope === of && !drilled && !library.query.trim();
}

const albumEntry: Presenter = (item, scope, ctx) => {
  if (!listing(scope, 'albums') || !item.title || !item.artist || !item.id || item.cataloguePath) return null;
  const album = { id: item.id, title: item.title, artist: item.artist };
  const count = Number(item.trackCount ?? 0);
  return {
    row: {
      kind: 'album',
      title: album.title,
      subtitle: count ? `${album.artist} · ${songs(count)}` : album.artist,
      chevron: true,
      artworkHash: item.artworkHash,
      thumb: true,
    },
    selection: { albumId: album.id, title: album.title },
    open: () => void ctx.nav.openAlbum(album),
  };
};

const artistEntry: Presenter = (item, scope, ctx) => {
  if (!listing(scope, 'artists') || !item.name || item.cataloguePath) return null;
  const name = item.name;
  return {
    row: { kind: 'artist', title: name, subtitle: songs(Number(item.trackCount ?? 0)), chevron: true },
    selection: { artist: name, title: name },
    open: () => void ctx.nav.openArtist(name),
  };
};

/** An album among search hits (rare): opens it in the Albums scope. */
const albumSearchHit: Presenter = (item, scope, ctx) => {
  if (scope.kind !== 'library' || !scope.library.query) return null;
  if (!item.title || !item.artist || !item.id || item.cataloguePath) return null;
  const album = { id: item.id, title: item.title, artist: item.artist };
  return {
    row: {
      kind: 'album',
      title: album.title,
      subtitle: album.artist,
      chevron: true,
      artworkHash: item.artworkHash,
      thumb: true,
    },
    selection: { albumId: album.id, title: album.title },
    open: () => void ctx.nav.openAlbum(album, 'albums'),
  };
};

const folderEntry: Presenter = (item, _scope, ctx) => {
  if (!item.isDirectory) return null;
  const path = String(item.path);
  const name = String(item.name);
  return {
    row: { kind: 'folder', title: name, subtitle: 'Folder', chevron: true },
    selection: { folder: path, title: name },
    open: () => void ctx.nav.openFolder(path),
  };
};

const trackEntry: Presenter = (item, scope, ctx) => {
  if (!(item.cataloguePath || item.track || item.title)) return null;
  // Folder entries wrap the track; browse and search send it bare.
  const track: Partial<Track> = item.track && typeof item.track === 'object' ? item.track : item;
  const path = track.cataloguePath ?? item.path ?? '';
  if (!path) return null;
  const labels = (track.labels ?? []).slice(0, 2).join(' · ');
  const artist = track.artist ?? '';
  return {
    row: {
      kind: 'track',
      // Folder browse may send a formatted name ("01 Title", a disc prefix).
      title: item.name || track.title || 'Track',
      subtitle: labels ? `${artist} · ${labels}` : artist,
      chevron: false,
      artworkHash: track.artworkHash,
      playing: path === nowPlayingPath(ctx.store.get()),
    },
    selection: { cataloguePath: path, title: track.title ?? item.name ?? 'Track' },
    open: () => {
      // The song already loaded pauses or resumes; its queue stays.
      if (!isCurrentTrack(ctx.store.get(), path)) {
        void ctx.actions.play(playContextFor(path, scope));
        return;
      }
      haptic('medium');
      void ctx.playback.transport('toggle').catch((err) => showToast(errorMessage(err, 'Playback failed'), { error: true }));
    },
    path,
  };
};

/** First match wins — the order is the precedence. */
const PRESENTERS: Presenter[] = [albumEntry, artistEntry, albumSearchHit, folderEntry, trackEntry];

/**
 * What playing a track from this list queues: the open playlist / label, or the album, artist
 * or folder browsed into — so next / previous walk the list the user sees.
 */
function playContextFor(cataloguePath: string, scope: ListScope): PlayContext {
  if (scope.kind === 'collection') {
    const { kind, id } = scope.collection;
    return kind === 'playlist' ? { cataloguePath, playlistId: id } : { cataloguePath, label: id };
  }
  const library = scope.library;
  if (library.scope === 'albums' && library.album) return { cataloguePath, albumId: library.album.id };
  if (library.scope === 'artists' && library.artist) return { cataloguePath, artist: library.artist };
  if (library.scope === 'folders' && library.folderPath) return { cataloguePath, folder: library.folderPath };
  return { cataloguePath };
}

/** Fills `list` with a row per item it can show. */
export function paintMediaList(list: HTMLElement, items: BrowseItem[], scope: ListScope, ctx: AppContext): void {
  list.innerHTML = '';
  if (!items.length) {
    list.innerHTML =
      scope.kind === 'collection'
        ? `<div class="empty"><strong>This Collection Is Empty</strong>Add music from your Catalogue.</div>`
        : `<div class="empty"><strong>No Music</strong>Add a folder in Settings → Sources.</div>`;
    return;
  }
  const inCollection = scope.kind === 'collection' ? scope.collection : null;
  for (const item of items) {
    const presented = PRESENTERS.reduce<PresentedRow | null>(
      (found, present) => found ?? present(item, scope, ctx),
      null
    );
    if (!presented) continue;
    list.appendChild(
      mediaRow({
        row: presented.row,
        covers: ctx.covers,
        path: presented.path,
        moreLabel: 'Actions',
        contextMenu: true,
        onOpen: presented.open,
        onMore: () => ctx.actions.organize(presented.selection, inCollection),
      })
    );
  }
  ctx.covers.hydrate(list);
}
