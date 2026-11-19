import type { AppContext } from '../../app/context';
import type { QueueSnapshot } from '../../api/types';
import { haptic } from '../../core/device';
import { errorMessage } from '../../core/errors';
import { formatTime } from '../../core/format';
import { paintRows, type RowEntry } from './mediaRow';
import { isDragging, paintReorderList } from './reorderList';
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

/**
 * The queue can be put in order when it was started from a playlist and plays unshuffled: a move
 * goes into the queue and the playlist, the song plays on.
 */
export function canReorderQueue(deps: QueueDeps): boolean {
  const { queue, nowPlaying } = deps.store.get();
  return Boolean(queue?.source.playlistId && queue.tracks.length > 1 && !nowPlaying?.shuffle);
}

/** Paint the queue in play order; a tap jumps to that index. */
export function paintQueueList(list: HTMLElement, deps: QueueDeps): void {
  const queue = deps.store.get().queue;
  list.classList.remove('reorder-list');
  list.innerHTML = '';
  if (!queue?.tracks.length) {
    list.innerHTML = `<div class="empty compact"><strong>Nothing Queued</strong>Play an album, a playlist or a folder.</div>`;
    return;
  }
  if (deps.store.get().reorder === 'queue' && canReorderQueue(deps)) {
    paintReorderList(
      list,
      queue.tracks.map((track, index) => ({
        key: track.cataloguePath,
        title: track.title,
        subtitle: track.artist,
        kind: 'track',
        number: index + 1,
      })),
      (paths) =>
        deps.playback
          .reorderQueue(paths)
          .catch((err) => showToast(errorMessage(err, 'Could not save the order'), { error: true }))
    );
    return;
  }
  const entries = queue.tracks.map(
    (track, index): RowEntry => ({
      // As in the Mac and iOS queue: the position, title and artist, the length at the end.
      row: {
        kind: 'track',
        title: track.title,
        subtitle: track.artist,
        chevron: false,
        number: index + 1,
        trailText: track.durationSecs ? formatTime(track.durationSecs) : '',
        playing: index === queue.currentIndex,
        paused: index === queue.currentIndex && deps.store.get().nowPlaying?.state !== 'playing',
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

/** Reorder / Done over the queue, while it can be put in order. */
function paintQueueTools(tools: HTMLElement, deps: QueueDeps): void {
  const can = canReorderQueue(deps);
  tools.hidden = !can;
  if (!can) {
    tools.innerHTML = '';
    return;
  }
  const on = deps.store.get().reorder === 'queue';
  tools.innerHTML = `
    <span class="queue-tools-note">${on ? 'Drag ≡ — the playlist follows' : ''}</span>
    <button type="button" class="group-action${on ? ' on' : ''}" data-queue-reorder aria-pressed="${on}">${
      on ? 'Done' : 'Reorder'
    }</button>`;
  tools.querySelector('[data-queue-reorder]')?.addEventListener('click', () =>
    deps.store.update((state) => ({ reorder: state.reorder === 'queue' ? null : 'queue' }))
  );
}

/** Keep a queue list in sync with the store. Returns dispose. */
export function bindQueueList(
  list: HTMLElement,
  deps: QueueDeps,
  onMeta?: (queue: QueueSnapshot | null) => void
): () => void {
  const tools = document.createElement('div');
  tools.className = 'queue-tools';
  list.before(tools);
  const refresh = (): void => {
    const queue = deps.store.get().queue;
    onMeta?.(queue);
    // Reorder ends when the queue can no longer be put in order (another queue, shuffle on).
    if (deps.store.get().reorder === 'queue' && !canReorderQueue(deps)) deps.store.update({ reorder: null });
    paintQueueTools(tools, deps);
    paintQueueList(list, deps);
  };
  refresh();
  list.querySelector('.row-wrap.playing')?.scrollIntoView({ block: 'nearest' });
  const unsubscribe = deps.store.subscribe((state, previous) => {
    if (!list.isConnected) {
      unsubscribe();
      tools.remove();
      return;
    }
    const shuffleChanged = state.nowPlaying?.shuffle !== previous.nowPlaying?.shuffle;
    if (state.queue === previous.queue && state.reorder === previous.reorder && !shuffleChanged) return;
    // A drag keeps its rows: they already show the order it makes.
    if (isDragging(list) && state.reorder === previous.reorder) return;
    refresh();
  });
  return () => {
    unsubscribe();
    tools.remove();
  };
}
