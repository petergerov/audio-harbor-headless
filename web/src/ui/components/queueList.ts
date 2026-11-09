import type { AppContext } from '../../app/context';
import type { QueueSnapshot } from '../../api/types';
import { haptic } from '../../core/device';
import { errorMessage } from '../../core/errors';
import { paintRows, type RowEntry } from './mediaRow';
import { showToast } from '../overlay';

export type QueueDeps = Pick<AppContext, 'store' | 'playback' | 'covers' | 'actions'>;

/** "Album · Kind of Blue", or "Queue" for a loose one. */
export function queueSourceLine(queue: QueueSnapshot | null): string {
  if (!queue) return 'Queue';
  return queue.source.name ? `${queue.source.kind} · ${queue.source.name}` : queue.source.kind;
}

export function queueContextTitle(queue: QueueSnapshot | null): string {
  if (queue?.source.name) return queue.source.name;
  if (!queue?.tracks.length) return 'No queue';
  return 'Queue';
}

export function queueContextSubtitle(queue: QueueSnapshot | null): string {
  if (!queue?.tracks.length) return '';
  const count = `${queue.tracks.length} track${queue.tracks.length === 1 ? '' : 's'}`;
  const current = queue.currentIndex === null ? undefined : queue.tracks[queue.currentIndex];
  const artist = current?.artist?.trim();
  if (artist) return `${artist.toUpperCase()} · ${count}`;
  return count;
}

/** Paint the queue in play order; a tap jumps to that index. */
export function paintQueueList(list: HTMLElement, deps: QueueDeps): void {
  const queue = deps.store.get().queue;
  list.innerHTML = '';
  if (!queue?.tracks.length) {
    list.innerHTML = `<div class="empty compact"><strong>Nothing Queued</strong>Play an album, a playlist or a folder.</div>`;
    return;
  }
  const entries = queue.tracks.map(
    (track, index): RowEntry => ({
      row: {
        kind: 'track',
        title: track.title,
        subtitle: track.artist,
        chevron: false,
        artworkHash: track.artworkHash,
        playing: index === queue.currentIndex,
      },
      path: track.cataloguePath,
      moreLabel: 'Actions',
      contextMenu: true,
      onOpen: () => {
        haptic(index === queue.currentIndex ? 'medium' : 'light');
        const jump = deps.playback
          .playQueueIndex(index)
          .catch((err) => showToast(errorMessage(err, 'Could not play'), { error: true }));
        // Another track: the row shows it is loading until the host answers.
        return index === queue.currentIndex ? undefined : jump;
      },
      onMore: () => deps.actions.organize({ cataloguePath: track.cataloguePath, title: track.title }, null),
    })
  );
  paintRows(list, entries, deps.covers);
}

/** Keep a queue list in sync with the store. Returns dispose. */
export function bindQueueList(
  list: HTMLElement,
  deps: QueueDeps,
  onMeta?: (queue: QueueSnapshot | null) => void
): () => void {
  const refresh = (): void => {
    const queue = deps.store.get().queue;
    onMeta?.(queue);
    paintQueueList(list, deps);
  };
  refresh();
  list.querySelector('.row-wrap.playing')?.scrollIntoView({ block: 'nearest' });
  const unsubscribe = deps.store.subscribe((state, previous) => {
    if (!list.isConnected) {
      unsubscribe();
      return;
    }
    if (state.queue === previous.queue) return;
    refresh();
  });
  return unsubscribe;
}
