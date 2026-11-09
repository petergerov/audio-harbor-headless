/** What a swipe on an element does; the first clear move decides whether it is one. */
export interface SwipeHandlers {
  /** Whether a move this way (from the start) is this element's swipe; else the page scrolls. */
  accept(dx: number, dy: number): boolean;
  /** The finger moved (from the start). */
  move(dx: number, dy: number): void;
  /** The finger lifted; velocities in px / ms. */
  end(dx: number, dy: number, vx: number, vy: number): void;
}

/** A move must be this long before its direction counts. */
const DECIDE_PX = 8;
/** A click this soon after a swipe is the finger lifting, not a tap. */
const SWALLOW_CLICK_MS = 350;

/**
 * Touch swipes on `el`. Starting on a control in `ignore` (sliders, fields) is never a swipe. While a
 * swipe is under way the page does not scroll; the click the lift may cause is dropped.
 */
export function bindSwipe(el: HTMLElement, handlers: SwipeHandlers, ignore = 'input, textarea, select'): void {
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;
  let lastT = 0;
  let vx = 0;
  let vy = 0;
  let state: 'idle' | 'deciding' | 'swiping' = 'idle';
  let swipedAt = 0;

  const move = (event: TouchEvent) => {
    const touch = event.touches[0];
    if (!touch || state === 'idle') return;
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    if (state === 'deciding') {
      if (Math.abs(dx) < DECIDE_PX && Math.abs(dy) < DECIDE_PX) return;
      if (!handlers.accept(dx, dy)) {
        stop();
        return;
      }
      state = 'swiping';
    }
    event.preventDefault();
    const dt = event.timeStamp - lastT;
    if (dt > 0) {
      vx = (touch.clientX - lastX) / dt;
      vy = (touch.clientY - lastY) / dt;
    }
    lastX = touch.clientX;
    lastY = touch.clientY;
    lastT = event.timeStamp;
    handlers.move(dx, dy);
  };

  const end = () => {
    const swiping = state === 'swiping';
    stop();
    if (!swiping) return;
    swipedAt = Date.now();
    handlers.end(lastX - startX, lastY - startY, vx, vy);
  };

  function stop(): void {
    state = 'idle';
    document.removeEventListener('touchmove', move);
    document.removeEventListener('touchend', end);
    document.removeEventListener('touchcancel', end);
  }

  el.addEventListener(
    'touchstart',
    (event) => {
      const touch = event.touches[0];
      if (event.touches.length !== 1 || !touch) return;
      if ((event.target as Element | null)?.closest(ignore)) return;
      startX = lastX = touch.clientX;
      startY = lastY = touch.clientY;
      lastT = event.timeStamp;
      vx = vy = 0;
      state = 'deciding';
      // Not passive only while a swipe may be under way, so scrolling never waits for it.
      document.addEventListener('touchmove', move, { passive: false });
      document.addEventListener('touchend', end);
      document.addEventListener('touchcancel', end);
    },
    { passive: true }
  );
  el.addEventListener(
    'click',
    (event) => {
      if (Date.now() - swipedAt < SWALLOW_CLICK_MS) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true
  );
}
