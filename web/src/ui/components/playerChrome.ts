import { haptic } from '../../core/device';
import { formatTime } from '../../core/format';
import { escapeHtml, required } from '../../core/html';
import type { Store } from '../../core/store';
import type { Navigation } from '../../services/navigator';
import type { AppState } from '../../state/appState';
import { currentTrack, durationSecs, isPlaying } from '../../state/selectors';
import { icons } from '../icons';
import type { Covers } from './covers';
import { bindPlayerControls, type PlayerControlDeps } from './playerControls';

export interface ChromeDeps extends PlayerControlDeps {
  store: Store<AppState>;
  covers: Covers;
  nav: Pick<Navigation, 'openNowPlaying'>;
}

/** A player strip around the screen; paints itself for the current track. */
export interface PlayerChrome {
  paint(el: HTMLElement): void;
}

function toggleButton(playing: boolean, small: boolean, className = 'play-btn'): string {
  const glyph = playing ? (small ? icons.pauseSm : icons.pause) : small ? icons.playSm : icons.play;
  const cls = className ? ` class="${className}"` : '';
  return `<button type="button"${cls} data-cmd="toggle"${small ? ' data-icon="sm"' : ''} aria-label="${playing ? 'Pause' : 'Play'}">${glyph}</button>`;
}

function openNowPlaying(deps: ChromeDeps): void {
  haptic('light');
  deps.nav.openNowPlaying();
}

/** Phone: above the tab bar on every screen but Now Playing. */
export class MiniPlayer implements PlayerChrome {
  constructor(private readonly deps: ChromeDeps) {}

  paint(el: HTMLElement): void {
    const state = this.deps.store.get();
    const track = currentTrack(state);
    if (!track) return;
    el.innerHTML = `
      <div class="mini-art" data-art>${icons.musicSm}</div>
      <button type="button" class="mini-text" data-open aria-label="Open Deck">
        <strong>${escapeHtml(track.title)}</strong>
        <span>${escapeHtml(track.artist)}</span>
      </button>
      <div class="mini-actions">
        ${toggleButton(isPlaying(state), true, '')}
        <button type="button" data-cmd="next" aria-label="Next">${icons.next}</button>
      </div>
    `;
    this.deps.covers.fill(el.querySelector('[data-art]'), track.artworkHash);
    required(el, '[data-open]').addEventListener('click', () => openNowPlaying(this.deps));
    bindPlayerControls(el, this.deps);
  }
}

/** Phone: compact player in the page header of Library and Playlists. */
export class HeaderPlayer implements PlayerChrome {
  constructor(private readonly deps: ChromeDeps) {}

  /** The slot a screen puts into its header; empty when the layout has no header player. */
  static slot(visible: boolean): string {
    return visible ? `<div class="header-player" id="headerPlayer" aria-label="Now Playing"></div>` : '';
  }

  paint(el: HTMLElement): void {
    const state = this.deps.store.get();
    const track = currentTrack(state);
    if (!track) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML = `
      <button type="button" class="header-player-main" data-open aria-label="Open Now Playing">
        <div class="header-player-art" data-art>${icons.musicSm}</div>
        <span class="header-player-text">
          <strong class="now-title">${escapeHtml(track.title)}</strong>
          <span class="now-artist">${escapeHtml(track.artist)}</span>
        </span>
      </button>
      <div class="header-player-actions">
        <button type="button" data-cmd="previous" aria-label="Previous">${icons.prev}</button>
        ${toggleButton(isPlaying(state), true)}
        <button type="button" data-cmd="next" aria-label="Next">${icons.next}</button>
      </div>
    `;
    this.deps.covers.fill(el.querySelector('[data-art]'), track.artworkHash);
    required(el, '[data-open]').addEventListener('click', () => openNowPlaying(this.deps));
    bindPlayerControls(el, this.deps);
  }
}

/** Desktop: the bottom bar, whenever a track is loaded. */
export class NowBar implements PlayerChrome {
  constructor(private readonly deps: ChromeDeps) {}

  paint(el: HTMLElement): void {
    const state = this.deps.store.get();
    const track = currentTrack(state);
    if (!track) {
      el.innerHTML = '';
      return;
    }
    const duration = durationSecs(state);
    const position = this.deps.clock.position;
    const volume = state.nowPlaying?.volume;
    el.innerHTML = `
      <button type="button" class="now-bar-track" data-open aria-label="Open Now Playing">
        <div class="now-bar-art" data-art>${icons.musicSm}</div>
        <span class="now-bar-text">
          <strong class="now-title">${escapeHtml(track.title)}</strong>
          <span class="now-artist">${escapeHtml(track.artist)}</span>
        </span>
      </button>
      <div class="now-bar-center">
        <div class="now-bar-transport">
          <button type="button" data-cmd="previous" aria-label="Previous">${icons.prev}</button>
          ${toggleButton(isPlaying(state), false)}
          <button type="button" data-cmd="next" aria-label="Next">${icons.next}</button>
        </div>
        <div class="now-bar-scrub">
          <span data-time-pos>${formatTime(position)}</span>
          <input data-seek type="range" min="0" max="${Math.max(duration, 1)}" step="0.1" value="${position}" />
          <span data-time-end>${duration ? formatTime(duration) : '--:--'}</span>
        </div>
      </div>
      <div class="now-bar-aside">
        <span class="now-bar-badge" data-now-badge>${escapeHtml(state.nowPlaying?.conversionBadge ?? '')}</span>
        <div class="now-bar-vol">
          ${icons.volMin}
          <input data-vol type="range" min="0" max="1" step="0.01" value="${Number(volume ?? 0.8)}" aria-label="Volume" ${volume == null ? 'disabled' : ''} />
        </div>
      </div>
    `;
    this.deps.covers.fill(el.querySelector('[data-art]'), track.artworkHash);
    required(el, '[data-open]').addEventListener('click', () => openNowPlaying(this.deps));
    bindPlayerControls(el, this.deps);
  }
}
