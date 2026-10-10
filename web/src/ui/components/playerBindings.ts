import type { RepeatMode, Track } from '../../api/types';
import { loadDeckStyle } from '../../core/deckStyle';
import { artistAlbumLine, formatTime, volumePercent } from '../../core/format';
import type { AppState } from '../../state/appState';
import { currentTrack, durationSecs, isPlaying, nowPlayingPath, playbackError } from '../../state/selectors';
import { icons } from '../icons';
import { syncDeckStage } from './deckStage';
import { PLAYING_GLYPH } from './mediaRow';

export const REPEAT_LABELS: Record<RepeatMode, string> = {
  off: 'Repeat off',
  all: 'Repeat queue',
  one: 'Repeat track',
};

/** Glyph and pressed state of a repeat button in `mode`. */
export function repeatButton(mode: RepeatMode): { glyph: string; pressed: boolean } {
  return { glyph: mode === 'one' ? icons.repeatOne : icons.repeat, pressed: mode !== 'off' };
}

/**
 * The markup contract for live player state. Any screen or player chrome may carry these
 * elements; `PlayerBindings` keeps all of them current without re-rendering their owners.
 *
 * Deck subtitle: mark with `data-line="deck"` for "Artist  ·  Album"; otherwise artist only.
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
  /** Optional percent label next to a volume slider. */
  volumePct: '[data-vol-pct]',
  error: '[data-now-error]',
  badge: '[data-now-badge]',
  /** Photoreal deck stage; play state and progress live here. */
  deckRig: '[data-deck-rig]',
  /** `aria-pressed` follows shuffle. */
  shuffle: '[data-shuffle]',
  /** `data-repeat` holds the mode; glyph, label and `aria-pressed` follow it. */
  repeat: '[data-repeat]',
  trackRow: '.row-wrap[data-path]',
} as const;

function artistLine(el: HTMLElement, track: Track | null): string {
  if (!track) return 'Choose something from Catalogue';
  return el.dataset.line === 'deck' ? artistAlbumLine(track.artist, track.album) : track.artist;
}

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
      el.textContent = artistLine(el, track);
    });
    this.each(PlayerMarkup.toggle, (el) => {
      const small = el.dataset.icon === 'sm';
      el.innerHTML = playing ? (small ? icons.pauseSm : icons.pause) : small ? icons.playSm : icons.play;
      if (el.hasAttribute('aria-label')) el.setAttribute('aria-label', playing ? 'Pause' : 'Play');
      el.classList.toggle('is-lit', playing);
      el.setAttribute('aria-pressed', String(playing));
    });
    const progress = duration > 0 ? Number(state.nowPlaying?.positionSecs ?? 0) / duration : 0;
    syncDeckStage(this.root, playing, loadDeckStyle(), progress);
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
    this.each(PlayerMarkup.shuffle, (el) => {
      el.setAttribute('aria-pressed', String(Boolean(state.nowPlaying?.shuffle)));
    });
    const repeat = state.nowPlaying?.repeat ?? 'off';
    this.each(PlayerMarkup.repeat, (el) => {
      if (el.dataset.repeat === repeat) return;
      const { glyph, pressed } = repeatButton(repeat);
      el.dataset.repeat = repeat;
      el.innerHTML = glyph;
      el.setAttribute('aria-pressed', String(pressed));
      el.setAttribute('aria-label', REPEAT_LABELS[repeat]);
    });
    // The output's volume moves on its own too (a network player's knob).
    const volume = state.nowPlaying?.volume;
    this.each<HTMLInputElement>(PlayerMarkup.volume, (el) => {
      el.disabled = volume == null;
      if (volume != null && document.activeElement !== el) el.value = String(volume);
    });
    this.each(PlayerMarkup.volumePct, (el) => {
      el.textContent = volume == null ? '—' : volumePercent(volume);
    });
    this.markTrackRows(nowPlayingPath(state));
  }

  /** Scrubbers, position labels and deck dolly; untouched while the user drags. */
  paintPosition(position: number, scrubbing: boolean, duration = 0): void {
    if (scrubbing) return;
    this.each<HTMLInputElement>(PlayerMarkup.seek, (el) => {
      el.value = String(position);
    });
    this.labelPosition(position);
    const playing = this.root.querySelector(PlayerMarkup.deckRig)?.classList.contains('is-playing') ?? false;
    syncDeckStage(this.root, playing, loadDeckStyle(), duration > 0 ? position / duration : 0);
  }

  /** Position labels alone — what a drag previews (deck dolly follows the thumb). */
  labelPosition(position: number): void {
    this.each(PlayerMarkup.position, (el) => {
      el.textContent = formatTime(position);
    });
    const seek = this.root.querySelector<HTMLInputElement>(PlayerMarkup.seek);
    const duration = Number(seek?.max ?? 0);
    const playing = this.root.querySelector(PlayerMarkup.deckRig)?.classList.contains('is-playing') ?? false;
    syncDeckStage(this.root, playing, loadDeckStyle(), duration > 0 ? position / duration : 0);
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
