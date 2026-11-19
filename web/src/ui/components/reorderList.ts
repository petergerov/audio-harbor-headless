import { haptic } from '../../core/device';
import { escapeAttr, escapeHtml } from '../../core/html';
import { icons } from '../icons';

/** One row of a list being put in order. */
export interface ReorderEntry {
  /** What the new order is made of: a playlist id or a catalogue path. */
  key: string;
  title: string;
  subtitle: string;
  /** A playlist shows its tile; songs show only their text. */
  kind: 'playlist' | 'track';
  /** A queue position in front of the title. */
  number?: number;
}

/** How near the top or bottom of the screen a drag scrolls it, and how fast. */
const EDGE_PX = 72;
const SCROLL_STEP_PX = 14;

/**
 * Fills `list` with `entries` and a drag handle (≡) on each, as the Mac and iOS remotes show
 * them under Reorder. A drop moves the row at once and hands `onMove` the keys in their new
 * order; the handle also moves its row with ↑ / ↓. While a drag runs, the list is left alone.
 */
export function paintReorderList(
  list: HTMLElement,
  entries: ReorderEntry[],
  onMove: (keys: string[]) => void | Promise<void>
): void {
  list.classList.add('reorder-list');
  list.innerHTML = entries
    .map(
      (entry) => `
      <div class="reorder-row" data-key="${escapeAttr(entry.key)}">
        ${
          entry.number !== undefined
            ? `<span class="row-num" aria-hidden="true">${entry.number}</span>`
            : entry.kind === 'playlist'
              ? `<span class="row-icon playlist" aria-hidden="true">${icons.macList}</span>`
              : ''
        }
        <span class="row-text">
          <span class="row-title">${escapeHtml(entry.title)}</span>
          ${entry.subtitle ? `<span class="row-sub">${escapeHtml(entry.subtitle)}</span>` : ''}
        </span>
        <button type="button" class="reorder-handle" aria-label="Move ${escapeAttr(entry.title)}" title="Drag, or press ↑ ↓">
          <span aria-hidden="true">≡</span>
        </button>
      </div>`
    )
    .join('');

  const rows = () => [...list.querySelectorAll<HTMLElement>('.reorder-row')];
  const keys = () => rows().map((row) => row.dataset.key ?? '');
  const renumber = () => {
    rows().forEach((row, i) => {
      const num = row.querySelector('.row-num');
      if (num) num.textContent = String(i + 1);
    });
  };
  const commit = (before: string[]) => {
    const after = keys();
    if (after.every((key, i) => key === before[i])) return;
    renumber();
    haptic('light');
    void Promise.resolve(onMove(after)).catch(() => undefined);
  };

  list.querySelectorAll<HTMLButtonElement>('.reorder-handle').forEach((handle) => {
    const row = handle.closest<HTMLElement>('.reorder-row')!;

    handle.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      event.preventDefault();
      const before = keys();
      if (event.key === 'ArrowUp' && row.previousElementSibling) list.insertBefore(row, row.previousElementSibling);
      else if (event.key === 'ArrowDown' && row.nextElementSibling) list.insertBefore(row.nextElementSibling, row);
      handle.focus();
      commit(before);
    });

    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        // A pointer that is gone already: the drag follows the handle's own events.
      }
      const before = keys();
      let lastY = event.clientY;
      row.classList.add('dragging');
      list.classList.add('is-dragging');
      haptic('medium');

      /** The row goes where the pointer is: past the middle of the row next to it. */
      const follow = (y: number) => {
        lastY = y;
        const prev = row.previousElementSibling as HTMLElement | null;
        const next = row.nextElementSibling as HTMLElement | null;
        if (prev) {
          const box = prev.getBoundingClientRect();
          if (y < box.top + box.height / 2) {
            list.insertBefore(row, prev);
            return follow(y);
          }
        }
        if (next) {
          const box = next.getBoundingClientRect();
          if (y > box.top + box.height / 2) {
            list.insertBefore(next, row);
            return follow(y);
          }
        }
      };
      // Near the screen's edge the page scrolls on, so a long playlist can be crossed.
      const scroller = window.setInterval(() => {
        const step = lastY < EDGE_PX ? -SCROLL_STEP_PX : lastY > window.innerHeight - EDGE_PX ? SCROLL_STEP_PX : 0;
        if (!step) return;
        window.scrollBy(0, step);
        follow(lastY);
      }, 16);

      const move = (e: PointerEvent) => follow(e.clientY);
      const end = () => {
        window.clearInterval(scroller);
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', end);
        handle.removeEventListener('pointercancel', end);
        row.classList.remove('dragging');
        list.classList.remove('is-dragging');
        commit(before);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    });
  });
}

/** Whether a drag is running in `list` — a repaint then would drop it. */
export function isDragging(list: HTMLElement | null): boolean {
  return Boolean(list?.classList.contains('is-dragging'));
}
