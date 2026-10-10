import { required } from '../../core/html';
import { icons } from '../icons';
import {
  bindQueueList,
  queueContextSubtitle,
  queueContextTitle,
  type QueueDeps,
} from './queueList';

const RAIL_KEY = 'ah.deck.queueRail';

/** Desktop Deck defaults to the queue rail open, like macOS Audio Harbor. */
export function loadQueueRailOpen(): boolean {
  try {
    const raw = localStorage.getItem(RAIL_KEY);
    if (raw === '0') return false;
    if (raw === '1') return true;
  } catch {
    /* private mode */
  }
  return true;
}

export function saveQueueRailOpen(open: boolean): void {
  try {
    localStorage.setItem(RAIL_KEY, open ? '1' : '0');
  } catch {
    /* private mode */
  }
}

export function deckQueueRailHtml(): string {
  return `
    <aside class="deck-queue-rail faceplate" data-deck-queue-rail aria-label="Up Next">
      <header class="deck-queue-header">
        <div class="deck-queue-headline">
          <p class="engraved" data-queue-kind>Queue</p>
          <h3 class="deck-queue-title" data-queue-title>Queue</h3>
          <p class="deck-queue-sub" data-queue-sub></p>
        </div>
        <button type="button" class="deck-pill" data-queue-hide aria-label="Hide Up Next">${icons.queue}</button>
      </header>
      <div class="queue-list deck-queue-list" data-queue-list></div>
    </aside>
  `;
}

/** Live queue rail beside the Deck. Returns dispose. */
export function bindDeckQueueRail(root: ParentNode, deps: QueueDeps, onHide: () => void): () => void {
  const host = root.querySelector<HTMLElement>('[data-deck-queue-rail]') ?? (root as HTMLElement);
  const list = required(host, '[data-queue-list]');
  const kindEl = host.querySelector('[data-queue-kind]');
  const titleEl = host.querySelector('[data-queue-title]');
  const subEl = host.querySelector<HTMLElement>('[data-queue-sub]');
  const disposeList = bindQueueList(list, deps, (queue) => {
    if (kindEl) kindEl.textContent = queue?.source.kind ?? 'Queue';
    if (titleEl) titleEl.textContent = queueContextTitle(queue);
    if (subEl) {
      const sub = queueContextSubtitle(queue);
      subEl.textContent = sub;
      subEl.hidden = !sub;
    }
  });
  host.querySelector('[data-queue-hide]')?.addEventListener('click', onHide);
  return disposeList;
}
