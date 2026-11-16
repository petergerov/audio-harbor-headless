import { haptic } from '../../core/device';
import { escapeAttr, escapeHtml } from '../../core/html';
import type { Navigation } from '../../services/navigator';
import type { AppState, Tab } from '../../state/appState';
import { icons } from '../icons';

interface Destination {
  tab: Tab;
  /** Tab bar (phone) and sidebar (desktop) wording. */
  short: string;
  long: string;
  icon: string;
}

/** Primary surfaces — the iOS remote's three, and Recordings after Catalogue when recording is on. */
const DESTINATIONS: Destination[] = [
  { tab: 'now', short: 'Deck', long: 'Deck', icon: icons.macHifi },
  { tab: 'library', short: 'Catalogue', long: 'Catalogue', icon: icons.macStack },
  { tab: 'recordings', short: 'Record', long: 'Recordings', icon: icons.navRecord },
  { tab: 'settings', short: 'Settings', long: 'Settings', icon: icons.macGear },
];

const destination = (tab: Tab) => DESTINATIONS.find((d) => d.tab === tab)!;

/** Recordings shows when the host can record and Recording is switched on (Settings → Record). */
export function recordingsShown(state: AppState): boolean {
  return Boolean(state.recording?.available && state.recording.enabled);
}

/** A take running: the Recordings entry glows red, wherever the user is. */
function liveClass(state: AppState, d: Destination): string {
  return d.tab === 'recordings' && state.recording && state.recording.state !== 'idle' ? ' rec-live' : '';
}

/** Phone: the bottom tab bar. */
export function tabBarHtml(state: AppState): string {
  const active = state.tab === 'collections' ? 'library' : state.tab;
  const shown = DESTINATIONS.filter((d) => d.tab !== 'recordings' || recordingsShown(state) || active === 'recordings');
  return `<nav class="tab-bar" id="tabs">
    ${shown
      .map(
        (d) => `<button type="button" data-tab="${d.tab}" class="${active === d.tab ? 'active' : ''}${liveClass(state, d)}">
        ${d.icon}<span>${d.short}</span>
      </button>`
      )
      .join('')}
  </nav>`;
}

/** Desktop: the sidebar with destinations, playlists and labels. */
export function sidebarHtml(state: AppState): string {
  const { tab } = state;
  const open = state.collections.open;
  const catalogueActive = tab === 'library' || tab === 'collections';
  const sideRow = (d: Destination, active: boolean) =>
    `<button type="button" class="side-row ${active ? 'active' : ''}${liveClass(state, d)}" data-nav="${d.tab}">${d.icon}<span>${d.long}</span></button>`;
  const collectionRow = (kind: 'playlist' | 'label', id: string, name: string, count: number) => `
      <button type="button" class="side-row ${tab === 'collections' && open?.kind === kind && open.id === id ? 'active' : ''}"
        data-nav="${kind}" data-id="${escapeAttr(id)}" data-name="${escapeAttr(name)}">
        <i class="side-dot ${kind}" aria-hidden="true"></i>
        <span>${escapeHtml(name)}</span>
        <em>${count}</em>
      </button>`;
  const playlists = state.collections.playlists.map((p) => collectionRow('playlist', p.id, p.name, p.trackCount)).join('');
  const labels = state.collections.labels.map((l) => collectionRow('label', l.name, l.name, l.trackCount)).join('');
  // As in the Mac app: the brand, Catalogue · (Recordings) · Deck · Settings, then the collections,
  // and the power lamp at the foot.
  const live = state.nowPlaying?.state === 'playing';
  return `
    <aside class="sidebar" aria-label="Navigation">
      <div class="side-brand"><img src="/brand-logo.png" alt="Audio Harbor" width="143" height="40" /></div>
      <nav class="side-nav">
        ${sideRow(destination('library'), catalogueActive && !open)}
        ${recordingsShown(state) || tab === 'recordings' ? sideRow(destination('recordings'), tab === 'recordings') : ''}
        ${sideRow(destination('now'), tab === 'now')}
        ${sideRow(destination('settings'), tab === 'settings')}
      </nav>
      <div class="side-heading">
        <p class="side-label">Playlists</p>
        <button type="button" class="side-plus" data-new-playlist aria-label="New playlist" title="New playlist">+</button>
      </div>
      <div class="side-scroll">${playlists || `<p class="side-empty">No playlists yet</p>`}</div>
      <div class="side-heading"><p class="side-label">Labels</p></div>
      <div class="side-scroll">${labels || `<p class="side-empty">No labels yet</p>`}</div>
      <div class="side-foot">
        <span class="power-lamp${live ? ' is-on' : ''}"><i aria-hidden="true"></i>${live ? 'Live' : 'Standby'}</span>
      </div>
    </aside>
  `;
}

/**
 * Wires tab bar, sidebar destinations, collections and the sidebar's `+` — one listener on the
 * frame, so the sidebar and tab bar can be replaced without binding again.
 */
export function bindNavigation(frame: HTMLElement, nav: Navigation, createPlaylist: () => void): void {
  frame.addEventListener('click', (event) => {
    const button = (event.target as Element | null)?.closest<HTMLElement>(
      '.tab-bar [data-tab], .sidebar [data-nav], .sidebar [data-new-playlist]'
    );
    if (!button) return;
    if (button.dataset.tab) {
      haptic('light');
      void nav.goTo(button.dataset.tab as Tab);
      return;
    }
    if (button.hasAttribute('data-new-playlist')) {
      createPlaylist();
      return;
    }
    const target = button.dataset.nav!;
    const id = button.dataset.id ?? '';
    if (target === 'playlist' || target === 'label') {
      void nav.openCollection(target, id, button.dataset.name ?? id);
    } else {
      void nav.goTo(target as Tab);
    }
  });
}
