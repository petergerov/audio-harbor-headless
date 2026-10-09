import { formatTime } from '../../core/format';
import type { AppState } from '../../state/appState';
import { currentTrack, durationSecs, isPlaying, nowPlayingPath, playbackError } from '../../state/selectors';
import { icons } from '../icons';
import { PLAYING_GLYPH } from './mediaRow';

/**
 * The markup contract for live player state. Any screen or player chrome may carry these
 * elements; `PlayerBindings` keeps all of them current without re-rendering their owners.
 */
export const PlayerMarkup = {
  title: '.now-title',
  artist: '.now-artist',
  /** Play / pause button; `data-icon="sm"` picks the small glyphs. */
  toggle: '[data-cmd="toggle"]',
  seek: 'input[data-seek]',
  position: '[data-time-pos]',
  duration: '[data-time-end]',
  volume: 'input[data-vol]',
  error: '[data-now-error]',
  badge: '[data-now-badge]',
  trackRow: '.row-wrap[data-path]',
} as const;

export class PlayerBindings {
  constructor(private readonly root: ParentNode = document) {}

  /** Everything that follows the now-playing snapshot. */
  sync(state: AppState): void {
    const track = currentTrack(state);
    const playing = isPlaying(state);
    const duration = durationSecs(state);
    this.each(PlayerMarkup.title, (el) => {
      el.textContent = track?.title ?? 'Not Playing';
    });
    this.each(PlayerMarkup.artist, (el) => {
      el.textContent = track?.artist ?? 'Choose something from Library';
    });
    this.each(PlayerMarkup.toggle, (el) => {
      const small = el.dataset.icon === 'sm';
      el.innerHTML = playing ? (small ? icons.pauseSm : icons.pause) : small ? icons.playSm : icons.play;
      if (el.hasAttribute('aria-label')) el.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    });
    this.each<HTMLInputElement>(PlayerMarkup.seek, (el) => {
      if (duration > 0) el.max = String(duration);
    });
    this.each(PlayerMarkup.duration, (el) => {
      el.textContent = duration ? formatTime(duration) : '--:--';
    });
    this.each(PlayerMarkup.error, (el) => {
      el.textContent = playbackError(state);
    });
    this.each(PlayerMarkup.badge, (el) => {
      el.textContent = state.nowPlaying?.conversionBadge ?? '';
    });
    // The output's volume moves on its own too (a network player's knob).
    const volume = state.nowPlaying?.volume;
    this.each<HTMLInputElement>(PlayerMarkup.volume, (el) => {
      el.disabled = volume == null;
      if (volume != null && document.activeElement !== el) el.value = String(volume);
    });
    this.markTrackRows(nowPlayingPath(state));
  }

  /** Scrubbers and position labels; untouched while the user drags. */
  paintPosition(position: number, scrubbing: boolean): void {
    if (scrubbing) return;
    this.each<HTMLInputElement>(PlayerMarkup.seek, (el) => {
      el.value = String(position);
    });
    this.labelPosition(position);
  }

  /** Position labels alone — what a drag previews. */
  labelPosition(position: number): void {
    this.each(PlayerMarkup.position, (el) => {
      el.textContent = formatTime(position);
    });
  }

  /** Highlights the playing track in any list on screen. */
  markTrackRows(path: string | null): void {
    this.each(PlayerMarkup.trackRow, (wrap) => {
      const on = Boolean(path && wrap.dataset.path === path);
      wrap.classList.toggle('playing', on);
      wrap.querySelector('.row')?.classList.toggle('playing', on);
      const trail = wrap.querySelector('.row-trail');
      if (!trail) return;
      if (on) {
        trail.innerHTML = PLAYING_GLYPH;
        trail.classList.add('playing');
      } else if (trail.classList.contains('playing')) {
        trail.innerHTML = '';
        trail.classList.remove('playing');
      }
    });
  }

  private each<E extends HTMLElement = HTMLElement>(selector: string, apply: (el: E) => void): void {
    this.root.querySelectorAll<E>(selector).forEach(apply);
  }
}
