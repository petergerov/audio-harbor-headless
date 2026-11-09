import type { AppContext } from '../app/context';
import { isDesktopUi } from '../core/device';
import { errorMessage } from '../core/errors';
import { required } from '../core/html';
import type { Transition } from '../services/navigator';
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

/**
 * The layout around the screens: sidebar or tab bar, player chrome, and the current view.
 * The frame is built once (again only when the window crosses the desktop breakpoint); navigation
 * swaps the view inside `#main`, and the chrome parts come and go on their own — so the mini player
 * and the sidebar stay put, and their entry animations play only when they appear.
 */
export class Shell {
  private view: View | null = null;
  private layout: Chrome | null = null;
  private frame: HTMLElement | null = null;
  /** Markup of the sidebar / tab bar on screen: replaced only when it changes. */
  private navMarkup = '';

  constructor(
    private readonly root: HTMLElement,
    private readonly ctx: AppContext,
    private readonly views: ViewRegistry,
    private readonly chrome: ShellChrome
  ) {
    // New or renamed playlists and labels show in the sidebar at once.
    ctx.store.subscribe((state, previous) => {
      const lists = state.collections;
      const before = previous.collections;
      if (lists.playlists !== before.playlists || lists.labels !== before.labels) this.syncNavigation();
    });
  }

  /** Whether the layout on screen still fits the state and the window width. */
  fits(): boolean {
    const want = chromeFor(this.ctx.store.get(), isDesktopUi());
    const have = this.layout;
    return Boolean(
      this.frame?.isConnected &&
        have &&
        have.wide === want.wide &&
        have.mini === want.mini &&
        have.header === want.header &&
        have.bar === want.bar
    );
  }

  /** The current tab's screen, inside a frame that fits the state. */
  render(transition: Transition = 'none'): void {
    const chrome = chromeFor(this.ctx.store.get(), isDesktopUi());
    if (this.needsFrame(chrome)) this.buildFrame(chrome);
    else this.syncChrome(chrome);
    this.syncNavigation();
    this.showView(transition, chrome);
  }

  /** The player chrome came or went (a track loaded, the window crossed the breakpoint); the view stays. */
  updateChrome(): void {
    const chrome = chromeFor(this.ctx.store.get(), isDesktopUi());
    if (this.needsFrame(chrome)) {
      this.render('none');
      return;
    }
    this.syncChrome(chrome);
  }

  /** Another track under the same layout: the chrome and the screen's track parts repaint, lists keep their scroll. */
  trackChanged(): void {
    this.paintChrome();
    this.paintHeader();
    this.view?.onTrackChange?.();
  }

  private needsFrame(chrome: Chrome): boolean {
    return !this.frame?.isConnected || !this.layout || this.layout.wide !== chrome.wide;
  }

  private buildFrame(chrome: Chrome): void {
    this.view?.dispose?.();
    this.view = null;
    this.root.innerHTML = `
      <div class="app-shell layout ${chrome.wide ? 'wide' : ''}">
        ${chrome.wide ? '<aside class="sidebar" aria-label="Navigation"></aside>' : ''}
        <div class="content-col">
          <main class="screen" id="main"></main>
          ${chrome.wide ? '' : '<nav class="tab-bar" id="tabs"></nav>'}
        </div>
      </div>
    `;
    const frame = required<HTMLElement>(this.root, '.app-shell');
    this.frame = frame;
    this.navMarkup = '';
    this.layout = null;
    bindNavigation(frame, this.ctx.nav, () => this.ctx.actions.createPlaylist());
    this.syncChrome(chrome);
  }

  /** Mini player and bottom bar in or out, painted when they appear. */
  private syncChrome(chrome: Chrome): void {
    const frame = this.frame;
    if (!frame) return;
    frame.classList.toggle('no-mini', !chrome.mini);
    frame.classList.toggle('has-bar', chrome.bar);

    let mini = frame.querySelector<HTMLElement>('#mini');
    if (chrome.mini && !mini) {
      mini = document.createElement('div');
      mini.className = 'mini-player';
      mini.id = 'mini';
      const column = required(frame, '.content-col');
      column.insertBefore(mini, column.querySelector('#tabs'));
      this.chrome.mini.paint(mini);
    } else if (!chrome.mini && mini) {
      mini.remove();
    }

    let bar = frame.querySelector<HTMLElement>('#nowBar');
    if (chrome.bar && !bar) {
      bar = document.createElement('footer');
      bar.className = 'now-bar';
      bar.id = 'nowBar';
      bar.setAttribute('aria-label', 'Deck');
      frame.appendChild(bar);
      this.chrome.bar.paint(bar);
    } else if (!chrome.bar && bar) {
      bar.remove();
    }
    this.layout = chrome;
  }

  /** The sidebar (desktop) or tab bar (phone) for the current tab, replaced only when it changes. */
  private syncNavigation(): void {
    const frame = this.frame;
    if (!frame?.isConnected || !this.layout) return;
    const state = this.ctx.store.get();
    const markup = this.layout.wide ? sidebarHtml(state) : tabBarHtml(state);
    if (markup === this.navMarkup) return;
    const current = frame.querySelector(this.layout.wide ? '.sidebar' : '.tab-bar');
    if (!current) return;
    // The sidebar's lists keep their scroll.
    const scrolls = Array.from(current.querySelectorAll('.side-scroll'), (el) => el.scrollTop);
    current.outerHTML = markup;
    frame.querySelectorAll('.sidebar .side-scroll').forEach((el, i) => {
      el.scrollTop = scrolls[i] ?? 0;
    });
    this.navMarkup = markup;
  }

  private showView(transition: Transition, chrome: Chrome): void {
    this.view?.dispose?.();
    const main = required(this.root, '#main');
    // Left over from an edge swipe.
    main.removeAttribute('style');
    main.classList.remove('enter-forward', 'enter-back');
    if (transition !== 'none') {
      void main.offsetWidth; // restart the entry animation
      main.classList.add(`enter-${transition}`);
    }
    main.innerHTML = '';
    const state = this.ctx.store.get();
    const view = this.views[state.tab](this.ctx);
    this.view = view;
    const host: ViewHost = { headerPlayerSlot: () => HeaderPlayer.slot(chrome.header) };
    Promise.resolve(view.render(main, host)).then(
      () => {
        if (this.view === view) this.paintHeader();
      },
      (err) => showToast(errorMessage(err, 'Could not load this screen'), { error: true })
    );
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
