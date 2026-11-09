import type { Store } from '../../core/store';
import type { AppState } from '../../state/appState';
import { hostHasNewRemote, reloadRemote } from '../reloadRemote';

/**
 * Each time the push channel opens (first connect, a host restart, back from the background), asks
 * whether the host serves a newer remote than the one on screen; then a pill at the top offers to
 * load it. A stale remote keeps working until then.
 */
export function watchForNewRemote(store: Store<AppState>): void {
  let shown = false;
  const check = async () => {
    if (shown || !(await hostHasNewRemote())) return;
    shown = true;
    const notice = document.createElement('button');
    notice.type = 'button';
    notice.className = 'update-notice';
    notice.innerHTML = `<span>New version of the remote</span><strong>Reload</strong>`;
    notice.addEventListener('click', () => void reloadRemote());
    document.body.appendChild(notice);
    requestAnimationFrame(() => notice.classList.add('show'));
  };
  store.subscribe((state, previous) => {
    if (state.connection === 'open' && previous.connection !== 'open') void check();
  });
}
