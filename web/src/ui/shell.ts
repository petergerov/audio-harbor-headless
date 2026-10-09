import type { AppContext } from '../app/context';
import { isDesktopUi } from '../core/device';
import { errorMessage } from '../core/errors';
import { required } from '../core/html';
import { chromeFor, type Chrome } from '../state/selectors';
import { bindNavigation, sidebarHtml, tabBarHtml } from './components/navigationBar';
import { HeaderPlayer, type PlayerChrome } from './components/playerChrome';
import { showToast } from './overlay';
import type { View, ViewHost, ViewRegistry } from './views/view';

export interface ShellChrome {
  mini: PlayerChrome;
  header: PlayerChrome;
  bar: PlayerChrome;
}

/** The layout around the screens: sidebar or tab bar, player chrome, and the current view. */
export class Shell {
  private view: View | null = null;
  private layout: Chrome | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly ctx: AppContext,
    private readonly views: ViewRegistry,
    private readonly chrome: ShellChrome
  ) {}

  /** Whether the layout on screen still fits the state and the window width. */
  fits(): boolean {
    const want = chromeFor(this.ctx.store.get(), isDesktopUi());
    const have = this.layout;
    return Boolean(
      have && have.wide === want.wide && have.mini === want.mini && have.header === want.header && have.bar === want.bar
    );
  }

  render(): void {
    this.view?.dispose?.();
    const state = this.ctx.store.get();
    const chrome = chromeFor(state, isDesktopUi());
    this.layout = chrome;
    this.root.innerHTML = `
      <div class="app-shell layout ${chrome.mini ? '' : 'no-mini'} ${chrome.wide ? 'wide' : ''} ${chrome.bar ? 'has-bar' : ''}">
        ${chrome.wide ? sidebarHtml(state) : ''}
        <div class="content-col">
          <main class="screen" id="main"></main>
          ${chrome.mini ? `<div class="mini-player" id="mini"></div>` : ''}
          ${chrome.wide ? '' : tabBarHtml(state)}
        </div>
        ${chrome.bar ? `<footer class="now-bar" id="nowBar" aria-label="Now Playing"></footer>` : ''}
      </div>
    `;
    bindNavigation(this.root, this.ctx.nav, () => this.ctx.actions.createPlaylist());

    const view = this.views[state.tab](this.ctx);
    this.view = view;
    const host: ViewHost = { headerPlayerSlot: () => HeaderPlayer.slot(chrome.header) };
    Promise.resolve(view.render(required(this.root, '#main'), host)).then(
      () => {
        if (this.view === view) this.paintHeader();
      },
      (err) => showToast(errorMessage(err, 'Could not load this screen'), { error: true })
    );
    this.paintChrome();
  }

  /** Another track under the same layout: the chrome and the screen's track parts repaint, lists keep their scroll. */
  trackChanged(): void {
    this.paintChrome();
    this.paintHeader();
    this.view?.onTrackChange?.();
  }

  private paintChrome(): void {
    const mini = this.root.querySelector<HTMLElement>('#mini');
    if (mini) this.chrome.mini.paint(mini);
    const bar = this.root.querySelector<HTMLElement>('#nowBar');
    if (bar) this.chrome.bar.paint(bar);
  }

  private paintHeader(): void {
    const slot = this.root.querySelector<HTMLElement>('#headerPlayer');
    if (slot) this.chrome.header.paint(slot);
  }
}
