import { isDesktopUi } from '../core/device';
import type { Navigation } from '../services/navigator';

/** How close to the left edge a back swipe starts. */
const EDGE_PX = 24;
/** Past this share of the width, or this fast (px / ms), the swipe goes back. */
const COMMIT_RATIO = 0.33;
const COMMIT_VELOCITY = 0.45;
const OUT_MS = 200;

/** Saved to the home screen: no browser chrome, and on iOS no back gesture of its own. */
export function isStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
}

/**
 * The home-screen app on a phone: a swipe from the left edge goes one level up, the page
 * following the finger. In a browser tab the browser's own gesture does it (through history).
 */
export function bindEdgeSwipe(nav: Pick<Navigation, 'canGoBack' | 'back'>): void {
  if (!isStandalone() || !('ontouchstart' in window)) return;

  let main: HTMLElement | null = null;
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let lastX = 0;
  let lastT = 0;
  let velocity = 0;
  let tracking = false;

  const move = (event: TouchEvent) => {
    const touch = event.touches[0];
    if (!main || !touch) return;
    const mx = touch.clientX - startX;
    const my = touch.clientY - startY;
    if (!tracking) {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
      // A scroll, or a swipe the other way: not ours.
      if (Math.abs(my) > Math.abs(mx) || mx < 0) {
        stop();
        return;
      }
      tracking = true;
      main.style.transition = 'none';
      main.style.willChange = 'transform';
    }
    event.preventDefault();
    dx = Math.max(0, mx);
    const dt = event.timeStamp - lastT;
    if (dt > 0) velocity = (touch.clientX - lastX) / dt;
    lastX = touch.clientX;
    lastT = event.timeStamp;
    main.style.transform = `translateX(${dx}px)`;
  };

  const end = () => {
    const el = main;
    const wasTracking = tracking;
    stop();
    if (!el || !wasTracking) return;
    const width = el.getBoundingClientRect().width || window.innerWidth;
    const commit = dx > width * COMMIT_RATIO || velocity > COMMIT_VELOCITY;
    el.style.transition = `transform ${OUT_MS}ms cubic-bezier(0.22, 0.9, 0.3, 1), opacity ${OUT_MS}ms ease`;
    if (!commit) {
      el.style.transform = '';
      window.setTimeout(() => el.removeAttribute('style'), OUT_MS);
      return;
    }
    el.style.transform = `translateX(${width}px)`;
    el.style.opacity = '0';
    // The next screen's render clears these styles; should nothing render, the page comes back.
    window.setTimeout(() => void nav.back(), OUT_MS - 20);
    window.setTimeout(() => {
      if (el.style.opacity === '0') el.removeAttribute('style');
    }, OUT_MS + 700);
  };

  function stop(): void {
    main = null;
    tracking = false;
    document.removeEventListener('touchmove', move);
    document.removeEventListener('touchend', end);
    document.removeEventListener('touchcancel', end);
  }

  document.addEventListener(
    'touchstart',
    (event) => {
      const touch = event.touches[0];
      if (event.touches.length !== 1 || !touch || touch.clientX > EDGE_PX) return;
      if (isDesktopUi() || document.body.classList.contains('overlay-open') || !nav.canGoBack()) return;
      if ((event.target as Element | null)?.closest('input, textarea, select')) return;
      main = document.getElementById('main');
      if (!main) return;
      startX = lastX = touch.clientX;
      startY = touch.clientY;
      lastT = event.timeStamp;
      dx = 0;
      velocity = 0;
      tracking = false;
      // Not passive only while a swipe may be under way, so scrolling never waits for it.
      document.addEventListener('touchmove', move, { passive: false });
      document.addEventListener('touchend', end);
      document.addEventListener('touchcancel', end);
    },
    { passive: true }
  );
}
