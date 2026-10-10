import type { AppContext } from '../../app/context';
import { isDesktopUi } from '../../core/device';
import { loadDeckStyle, type DeckStyle } from '../../core/deckStyle';
import { artistAlbumLine, formatTime, volumePercent } from '../../core/format';
import { escapeHtml } from '../../core/html';
import { currentTrack, durationSecs, isPlaying, playbackError } from '../../state/selectors';
import { bindDeckChrome } from '../components/deckChrome';
import {
  bindDeckQueueRail,
  deckQueueRailHtml,
  loadQueueRailOpen,
  saveQueueRailOpen,
} from '../components/deckQueueRail';
import { bindDeckStage, deckStageHtml } from '../components/deckStage';
import { REPEAT_LABELS, repeatButton } from '../components/playerBindings';
import { bindPlayerControls } from '../components/playerControls';
import { icons } from '../icons';
import { openQueueSheet } from '../sheets/queueSheet';
import type { View } from './view';

/** Deck: photoreal stage (Turntable / Reel-to-Reel), cover chip, hardware transport. */
export class NowPlayingView implements View {
  private root: HTMLElement | null = null;
  private style: DeckStyle = loadDeckStyle();
  private railOpen = loadQueueRailOpen();
  private disposeStage: (() => void) | null = null;
  private disposeRail: (() => void) | null = null;

  constructor(private readonly ctx: AppContext) {}

  render(root: HTMLElement): void {
    this.disposeStage?.();
    this.disposeRail?.();
    this.root = root;
    this.style = loadDeckStyle();
    const desktop = isDesktopUi();
    if (desktop) this.railOpen = loadQueueRailOpen();
    const state = this.ctx.store.get();
    const track = currentTrack(state);
    const duration = durationSecs(state);
    const position = this.ctx.clock.position;
    const progress = duration > 0 ? position / duration : 0;
    const volume = state.nowPlaying?.volume;
    const playing = isPlaying(state);
    const disabled = track ? '' : 'disabled';
    const repeat = state.nowPlaying?.repeat ?? 'off';
    const repeatLook = repeatButton(repeat);
    const subtitle = track ? artistAlbumLine(track.artist, track.album) : 'Choose something from Catalogue';
    const showRail = desktop && this.railOpen;
    const actions = `
      ${
        volume != null
          ? `<button type="button" class="deck-pill" data-vol-toggle aria-label="Volume" aria-pressed="false">${icons.volMax}</button>`
          : ''
      }
      <button type="button" class="deck-pill ${showRail ? 'is-on' : ''}" data-queue
        aria-label="Up Next" aria-pressed="${showRail}">${icons.queue}</button>
    `;
    root.innerHTML = `
      <section class="now-screen ${desktop ? 'is-desktop' : ''} ${showRail ? 'has-queue-rail' : ''}">
        <div class="deck-layout">
          <div class="deck-stage faceplate compact">
            ${deckStageHtml({
              style: this.style,
              playing,
              progress,
              artworkHash: track?.artworkHash ?? null,
              title: track?.title ?? 'Track',
            })}
            <div class="deck-panel">
              <div class="volume-drawer" data-vol-drawer hidden>
                ${icons.volMin}
                <input data-vol type="range" min="0" max="1" step="0.01" value="${Number(volume ?? 0.8)}" ${volume == null ? 'disabled' : ''} />
                <span class="vol-pct" data-vol-pct>${volume == null ? '—' : volumePercent(volume)}</span>
              </div>
              <div class="now-meta">
                <h2 class="now-title">${escapeHtml(track?.title ?? 'Not Playing')}</h2>
                <p class="now-artist" data-line="deck">${escapeHtml(subtitle)}</p>
                <span class="now-badge" data-now-badge>${escapeHtml(state.nowPlaying?.conversionBadge ?? '')}</span>
                <p class="now-error" data-now-error>${escapeHtml(playbackError(state))}</p>
              </div>
              <div class="scrub">
                <input data-seek type="range" min="0" max="${Math.max(duration, 1)}" step="0.1" value="${position}" ${disabled} />
                <div class="time-row"><span data-time-pos>${formatTime(position)}</span><span data-time-end>${duration ? formatTime(duration) : '--:--'}</span></div>
              </div>
              <div class="transport">
                <button type="button" class="mode-btn" data-shuffle aria-label="Shuffle"
                  aria-pressed="${Boolean(state.nowPlaying?.shuffle)}" ${disabled}>${icons.shuffle}</button>
                <button type="button" class="icon-btn" data-cmd="previous" ${disabled}>${icons.prev}</button>
                <button type="button" class="play-btn ${playing ? 'is-lit' : ''}" data-cmd="toggle"
                  aria-pressed="${playing}" ${disabled}>
                  ${playing ? icons.pause : icons.play}
                </button>
                <button type="button" class="icon-btn" data-cmd="next" ${disabled}>${icons.next}</button>
                <button type="button" class="mode-btn" data-repeat="${repeat}" aria-label="${REPEAT_LABELS[repeat]}"
                  aria-pressed="${repeatLook.pressed}" ${disabled}>${repeatLook.glyph}</button>
              </div>
            </div>
          </div>
          ${showRail ? deckQueueRailHtml() : ''}
        </div>
      </section>
    `;
    const slot = root.querySelector('[data-deck-toolbar-slot]');
    if (slot) slot.innerHTML = actions;
    this.disposeStage = bindDeckStage(
      root,
      this.ctx.covers,
      {
        style: this.style,
        playing,
        progress,
        artworkHash: track?.artworkHash ?? null,
        title: track?.title ?? 'Track',
      },
      (style) => {
        this.style = style;
        if (this.root?.isConnected) this.render(this.root);
      }
    );
    bindPlayerControls(root, this.ctx);
    bindDeckChrome(root);
    if (showRail) {
      this.disposeRail = bindDeckQueueRail(root, this.ctx, () => this.setRailOpen(false));
    }
    root.querySelector('[data-queue]')?.addEventListener('click', () => {
      if (isDesktopUi()) {
        this.setRailOpen(!this.railOpen);
        return;
      }
      openQueueSheet(this.ctx);
    });
  }

  onTrackChange(): void {
    if (this.root?.isConnected) this.render(this.root);
  }

  dispose(): void {
    this.disposeStage?.();
    this.disposeStage = null;
    this.disposeRail?.();
    this.disposeRail = null;
    this.root = null;
  }

  private setRailOpen(open: boolean): void {
    this.railOpen = open;
    saveQueueRailOpen(open);
    if (this.root?.isConnected) this.render(this.root);
  }
}
