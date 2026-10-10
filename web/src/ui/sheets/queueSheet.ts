import { required } from '../../core/html';
import { bindQueueList, queueSourceLine, type QueueDeps } from '../components/queueList';
import { openPanel } from '../overlay';

/**
 * The queue in play order: a tap jumps to that track (the one playing pauses or resumes).
 * Follows the host while it is open. Used on narrow layouts; desktop Deck uses the rail.
 */
export function openQueueSheet(deps: QueueDeps): void {
  openPanel({
    title: 'Up Next',
    subtitle: queueSourceLine(deps.store.get().queue),
    bodyHtml: `<div class="ah-group queue-list" data-queue-list></div>`,
    bind: (root) => {
      const list = required(root, '[data-queue-list]');
      const subtitle = root.querySelector('.ah-sub');
      bindQueueList(list, deps, (queue) => {
        if (subtitle) subtitle.textContent = queueSourceLine(queue);
      });
      list.querySelector('.row-wrap.playing')?.scrollIntoView({ block: 'center' });
    },
  });
}
