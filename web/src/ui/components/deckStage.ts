import {
  DECK_STYLES,
  deckEngraved,
  deckProgressLabel,
  deckStageSrc,
  deckStatusLabel,
  loadDeckStyle,
  saveDeckStyle,
  type DeckStyle,
} from '../../core/deckStyle';
import { escapeAttr, escapeHtml } from '../../core/html';
import type { Covers } from './covers';

/** Same breakpoint as the desktop shell (`isDesktopUi`). */
const WIDE_MQ = '(min-width: 700px)';

export interface DeckStageModel {
  style: DeckStyle;
  playing: boolean;
  progress: number;
  artworkHash: string | null;
  title: string;
}

/** Markup for the photoreal stage + style picker (Turntable / Reel-to-Reel). */
export function deckStageHtml(model: DeckStageModel): string {
  const wide = window.matchMedia(WIDE_MQ).matches;
  const src = deckStageSrc(model.style, wide);
  return `
    <header class="deck-header">
      <p class="engraved deck-plate" data-deck-plate>${escapeHtml(deckEngraved(model.style))}</p>
      <div class="deck-style-bar">
        <div class="deck-style-picker" role="group" aria-label="Deck style">
          ${DECK_STYLES.map(
            (s) =>
              `<button type="button" class="deck-pill ${model.style === s.id ? 'is-on' : ''}"
                data-deck-style="${s.id}" aria-pressed="${model.style === s.id}">${escapeHtml(s.title.toUpperCase())}</button>`
          ).join('')}
        </div>
        <div class="deck-toolbar-slot" data-deck-toolbar-slot></div>
      </div>
    </header>
    <div class="deck-visual">
      <div class="deck-rig ${model.playing ? 'is-playing' : ''}" data-deck-rig data-deck-kind="${model.style}"
        style="--deck-progress: ${clamp01(model.progress)}">
        <div class="deck-rig-meta">
          <span class="engraved" data-deck-status>${escapeHtml(deckStatusLabel(model.style, model.playing))}</span>
          <span class="engraved" data-deck-groove>${escapeHtml(deckProgressLabel(model.style, model.progress))}</span>
        </div>
        <div class="deck-hero" data-deck-hero>
          <img class="deck-photo" data-deck-photo src="${escapeAttr(src)}" alt="" draggable="false" />
          <div class="deck-shimmer" aria-hidden="true"></div>
          <div class="deck-grade" aria-hidden="true"></div>
          <div class="deck-cover" data-deck-cover></div>
          <span class="deck-led" aria-hidden="true"></span>
        </div>
      </div>
    </div>
  `;
}

/**
 * Style picker, cover chip, and layout swaps when the viewport crosses the wide breakpoint.
 * Returns a dispose function for the media-query listener.
 */
export function bindDeckStage(
  root: ParentNode,
  covers: Covers,
  model: DeckStageModel,
  onStyleChange: (style: DeckStyle) => void
): () => void {
  paintCover(root, covers, model.artworkHash, model.title);
  root.querySelectorAll<HTMLButtonElement>('[data-deck-style]').forEach((button) => {
    button.addEventListener('click', () => {
      const style = button.dataset.deckStyle as DeckStyle;
      if (style !== 'turntable' && style !== 'reelToReel') return;
      saveDeckStyle(style);
      onStyleChange(style);
    });
  });
  const mql = window.matchMedia(WIDE_MQ);
  const onWide = () => {
    const photo = root.querySelector<HTMLImageElement>('[data-deck-photo]');
    if (photo) photo.src = deckStageSrc(loadDeckStyle(), mql.matches);
  };
  mql.addEventListener('change', onWide);
  return () => mql.removeEventListener('change', onWide);
}

/** Live play / pause and progress without rebuilding the stage. */
export function syncDeckStage(root: ParentNode, playing: boolean, style: DeckStyle, progress: number): void {
  const rig = root.querySelector<HTMLElement>('[data-deck-rig]');
  if (!rig) return;
  rig.classList.toggle('is-playing', playing);
  rig.dataset.deckKind = style;
  const p = clamp01(progress);
  rig.style.setProperty('--deck-progress', String(p));
  const status = root.querySelector('[data-deck-status]');
  const groove = root.querySelector('[data-deck-groove]');
  if (status) status.textContent = deckStatusLabel(style, playing);
  if (groove) groove.textContent = deckProgressLabel(style, p);
}

function paintCover(root: ParentNode, covers: Covers, hash: string | null, title: string): void {
  const slot = root.querySelector<HTMLElement>('[data-deck-cover]');
  if (!slot) return;
  if (!hash) {
    slot.innerHTML = '';
    slot.hidden = true;
    return;
  }
  slot.hidden = false;
  const img = covers.img(hash, false);
  slot.innerHTML = img ?? `<span class="cover-fallback">${escapeHtml(title.trim()[0]?.toUpperCase() ?? '•')}</span>`;
  covers.hydrate(slot);
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
}
