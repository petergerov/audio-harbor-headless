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

const DESTINATIONS: Destination[] = [
  { tab: 'now', short: 'Deck', long: 'Deck', icon: icons.now },
  { tab: 'library', short: 'Catalogue', long: 'Catalogue', icon: icons.browse },
  { tab: 'collections', short: 'Playlists', long: 'Playlists &amp; Labels', icon: icons.library },
  { tab: 'settings', short: 'Settings', long: 'Settings', icon: icons.settings },
];

const destination = (tab: Tab) => DESTINATIONS.find((d) => d.tab === tab)!;

/** Phone: the bottom tab bar. */
export function tabBarHtml(state: AppState): string {
  return `<nav class="tab-bar" id="tabs">
    ${DESTINATIONS.map(
      (d) => `<button type="button" data-tab="${d.tab}" class="${state.tab === d.tab ? 'active' : ''}">
        ${d.icon}<span>${d.short}</span>
      </button>`
    ).join('')}
  </nav>`;
}

/** Desktop: the sidebar with destinations, playlists and labels. */
export function sidebarHtml(state: AppState): string {
  const { tab } = state;
  const open = state.collections.open;
  const sideRow = (d: Destination, active: boolean) =>
    `<button type="button" class="side-row ${active ? 'active' : ''}" data-nav="${d.tab}">${d.icon}<span>${d.long}</span></button>`;
  const collectionRow = (kind: 'playlist' | 'label', id: string, name: string, count: number) => `
      <button type="button" class="side-row ${tab === 'collections' && open?.kind === kind && open.id === id ? 'active' : ''}"
        data-nav="${kind}" data-id="${escapeAttr(id)}" data-name="${escapeAttr(name)}">
        <i class="side-dot ${kind}" aria-hidden="true"></i>
        <span>${escapeHtml(name)}</span>
        <em>${count}</em>
      </button>`;
  const playlists = state.collections.playlists.map((p) => collectionRow('playlist', p.id, p.name, p.trackCount)).join('');
  const labels = state.collections.labels.map((l) => collectionRow('label', l.name, l.name, l.trackCount)).join('');
  return `
    <aside class="sidebar" aria-label="Navigation">
      <div class="side-brand">Audio Harbor</div>
      ${sideRow(destination('now'), tab === 'now')}
      ${sideRow(destination('library'), tab === 'library')}
      ${sideRow(destination('collections'), tab === 'collections' && !open)}
      <div class="side-heading">
        <p class="side-label">Playlists</p>
        <button type="button" class="side-plus" data-new-playlist aria-label="New playlist" title="New playlist">+</button>
      </div>
      <div class="side-scroll">${playlists || `<p class="side-empty">No playlists yet</p>`}</div>
      <div class="side-heading"><p class="side-label">Labels</p></div>
      <div class="side-scroll">${labels || `<p class="side-empty">No labels yet</p>`}</div>
      <div class="side-foot">
        ${sideRow(destination('settings'), tab === 'settings')}
      </div>
    </aside>
  `;
}

/** Wires tab bar, sidebar destinations, collections and the sidebar's `+`. */
export function bindNavigation(root: ParentNode, nav: Navigation, createPlaylist: () => void): void {
  root.querySelectorAll<HTMLElement>('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      haptic('light');
      void nav.goTo(button.dataset.tab as Tab);
    });
  });
  root.querySelectorAll<HTMLElement>('[data-nav]').forEach((button) => {
    button.addEventListener('click', () => {
      const target = button.dataset.nav!;
      const id = button.dataset.id ?? '';
      if (target === 'playlist' || target === 'label') {
        void nav.openCollection(target, id, button.dataset.name ?? id);
      } else {
        void nav.goTo(target as Tab);
      }
    });
  });
  root.querySelector('[data-new-playlist]')?.addEventListener('click', () => createPlaylist());
}
