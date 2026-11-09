import type { Store } from '../../core/store';
import type { AppState } from '../../state/appState';

/** A short drop (a reconnect after waking) stays silent; longer ones show. */
const SHOW_AFTER_MS = 1200;

/**
 * A small pill at the top while the host cannot be reached — instead of a remote that silently
 * stops moving. Lives on `body`, so the shell can rebuild beneath it.
 */
export function mountConnectionBanner(store: Store<AppState>): void {
  const banner = document.createElement('div');
  banner.className = 'connection-banner';
  banner.setAttribute('role', 'status');
  banner.setAttribute('aria-live', 'polite');
  banner.innerHTML = `<span class="connection-dot" aria-hidden="true"></span><span>Connecting to Harbor…</span>`;
  document.body.appendChild(banner);

  let timer: number | undefined;
  const apply = (connection: AppState['connection']) => {
    window.clearTimeout(timer);
    if (connection === 'open') {
      banner.classList.remove('show');
      return;
    }
    timer = window.setTimeout(() => banner.classList.add('show'), SHOW_AFTER_MS);
  };
  apply(store.get().connection);
  store.subscribe((state, previous) => {
    if (state.connection !== previous.connection) apply(state.connection);
  });
}
