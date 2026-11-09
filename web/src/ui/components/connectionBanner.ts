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
  // `host-offline` on body: failure toasts stay quiet, the player controls dim.
  const show = (on: boolean) => {
    banner.classList.toggle('show', on);
    document.body.classList.toggle('host-offline', on);
  };
  const apply = (connection: AppState['connection']) => {
    window.clearTimeout(timer);
    if (connection === 'open') {
      show(false);
      return;
    }
    timer = window.setTimeout(() => show(true), SHOW_AFTER_MS);
  };
  apply(store.get().connection);
  store.subscribe((state, previous) => {
    if (state.connection !== previous.connection) apply(state.connection);
  });
}
