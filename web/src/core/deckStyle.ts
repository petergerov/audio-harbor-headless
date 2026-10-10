/** Deck hero styles — same compact choices as the iOS remote (no Receiver on phone). */
export type DeckStyle = 'turntable' | 'reelToReel';

export const DECK_STYLES: ReadonlyArray<{ id: DeckStyle; title: string }> = [
  { id: 'turntable', title: 'Turntable' },
  { id: 'reelToReel', title: 'Reel-to-Reel' },
];

const STORAGE_KEY = 'harbor.deckStyle';

export function loadDeckStyle(): DeckStyle {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw === 'reelToReel' ? 'reelToReel' : 'turntable';
}

export function saveDeckStyle(style: DeckStyle): void {
  localStorage.setItem(STORAGE_KEY, style);
}

/** Status line left of the stage (needle / transport). */
export function deckStatusLabel(style: DeckStyle, playing: boolean): string {
  if (style === 'reelToReel') {
    return playing ? 'Open Reel · Transport' : 'Open Reel · Stop';
  }
  return playing ? 'Needle Down · 33⅓' : 'Cue Rest';
}

/** Status line right of the stage (groove / tape progress). */
export function deckProgressLabel(style: DeckStyle, progress: number): string {
  const p = Math.min(1, Math.max(0, progress));
  if (style === 'reelToReel') {
    if (p <= 0.02) return 'Leader';
    if (p >= 0.98) return 'Tail';
    return `Tape ${Math.round(p * 100)}%`;
  }
  if (p <= 0.02) return 'Lead-in';
  if (p >= 0.98) return 'Run-out';
  return `Groove ${Math.round(p * 100)}%`;
}

/** Photoreal stage photos under /deck/ (portrait for phones, wide from 560px). */
export function deckStageSrc(style: DeckStyle, wide: boolean): string {
  if (style === 'reelToReel') {
    return wide ? '/deck/reel-wide.jpg' : '/deck/reel-portrait.jpg';
  }
  return wide ? '/deck/turntable-wide.jpg' : '/deck/turntable-portrait.jpg';
}
