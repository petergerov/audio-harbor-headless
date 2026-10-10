import type { AppContext } from '../../app/context';
import type { QueueSnapshot } from '../../api/types';
import { haptic } from '../../core/device';
import { errorMessage } from '../../core/errors';
import { required } from '../../core/html';
import { mediaRow } from '../components/mediaRow';
import { openPanel, showToast } from '../overlay';

type QueueDeps = Pick<AppContext, 'store' | 'playback' | 'covers' | 'actions'>;

/** "Album · Kind of Blue", or "Queue" for a loose one. */
function sourceLine(queue: QueueSnapshot | null): string {
  if (!queue) return 'Queue';
  return queue.source.name ? `${queue.source.kind} · ${queue.source.name}` : queue.source.kind;
}

function paint(list: HTMLElement, deps: QueueDeps): void {
  const queue = deps.store.get().queue;
  list.innerHTML = '';
  if (!queue?.tracks.length) {
    list.innerHTML = `<div class="empty compact"><strong>Nothing Queued</strong>Play an album, a playlist or a folder.</div>`;
    return;
  }
  queue.tracks.forEach((track, index) => {
    list.appendChild(
      mediaRow({
        row: {
          kind: 'track',
          title: track.title,
          subtitle: track.artist,
          chevron: false,
          artworkHash: track.artworkHash,
          playing: index === queue.currentIndex,
        },
        covers: deps.covers,
        path: track.cataloguePath,
        moreLabel: 'Actions',
        contextMenu: true,
        onOpen: () => {
          haptic(index === queue.currentIndex ? 'medium' : 'light');
          void deps.playback
            .playQueueIndex(index)
            .catch((err) => showToast(errorMessage(err, 'Could not play'), { error: true }));
        },
        onMore: () => deps.actions.organize({ cataloguePath: track.cataloguePath, title: track.title }, null),
      })
    );
  });
  deps.covers.hydrate(list);
}

/**
 * The queue in play order: a tap jumps to that track (the one playing pauses or resumes).
 * Follows the host while it is open.
 */
export function openQueueSheet(deps: QueueDeps): void {
  openPanel({
    title: 'Up Next',
    subtitle: sourceLine(deps.store.get().queue),
    bodyHtml: `<div class="ah-group queue-list" data-queue-list></div>`,
    bind: (root) => {
      const list = required(root, '[data-queue-list]');
      const subtitle = root.querySelector('.ah-sub');
      paint(list, deps);
      list.querySelector('.row-wrap.playing')?.scrollIntoView({ block: 'center' });
      const unsubscribe = deps.store.subscribe((state, previous) => {
        if (!list.isConnected) {
          unsubscribe();
          return;
        }
        if (state.queue === previous.queue) return;
        if (subtitle) subtitle.textContent = sourceLine(state.queue);
        paint(list, deps);
      });
    },
  });
}
