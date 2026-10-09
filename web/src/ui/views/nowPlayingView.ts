import type { AppContext } from '../../app/context';
import { formatTime } from '../../core/format';
import { escapeHtml } from '../../core/html';
import { currentTrack, durationSecs, isPlaying, playbackError } from '../../state/selectors';
import { bindPlayerControls } from '../components/playerControls';
import { icons } from '../icons';
import type { View } from './view';

/** The full player: cover, track, path badge, scrubber, transport and volume. */
export class NowPlayingView implements View {
  private root: HTMLElement | null = null;

  constructor(private readonly ctx: AppContext) {}

  render(root: HTMLElement): void {
    this.root = root;
    const state = this.ctx.store.get();
    const track = currentTrack(state);
    const duration = durationSecs(state);
    const position = this.ctx.clock.position;
    const volume = state.nowPlaying?.volume;
    const disabled = track ? '' : 'disabled';
    root.innerHTML = `
      <section class="now-screen">
        <div class="artwork" data-art>${icons.music}</div>
        <div class="now-meta">
          <h2 class="now-title">${escapeHtml(track?.title ?? 'Not Playing')}</h2>
          <p class="now-artist">${escapeHtml(track?.artist ?? 'Choose something from Library')}</p>
          <span class="now-badge" data-now-badge>${escapeHtml(state.nowPlaying?.conversionBadge ?? '')}</span>
          <p class="now-error" data-now-error>${escapeHtml(playbackError(state))}</p>
        </div>
        <div class="scrub">
          <input data-seek type="range" min="0" max="${Math.max(duration, 1)}" step="0.1" value="${position}" ${disabled} />
          <div class="time-row"><span data-time-pos>${formatTime(position)}</span><span data-time-end>${duration ? formatTime(duration) : '--:--'}</span></div>
        </div>
        <div class="transport">
          <button type="button" class="icon-btn" data-cmd="previous" ${disabled}>${icons.prev}</button>
          <button type="button" class="play-btn" data-cmd="toggle" ${disabled}>
            ${isPlaying(state) ? icons.pause : icons.play}
          </button>
          <button type="button" class="icon-btn" data-cmd="next" ${disabled}>${icons.next}</button>
        </div>
        <div class="volume-row">
          ${icons.volMin}
          <input data-vol type="range" min="0" max="1" step="0.01" value="${Number(volume ?? 0.8)}" ${volume == null ? 'disabled' : ''} />
          ${icons.volMax}
        </div>
      </section>
    `;
    this.ctx.covers.fill(root.querySelector('[data-art]'), track?.artworkHash);
    bindPlayerControls(root, this.ctx);
  }

  onTrackChange(): void {
    if (this.root?.isConnected) this.render(this.root);
  }
}
