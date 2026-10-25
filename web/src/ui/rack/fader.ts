import { escapeAttr, escapeHtml } from '../../core/html';
import { onDrag } from './drag';
import { onDoubleTap, type ParamIO } from './paramControls';
import type { Scale } from './paramModel';

/**
 * A vertical fader, as on a graphic EQ: drag the cap, arrow keys for steps, double tap for
 * the default. Its scale is the panel's (±15 dB), not the plugin's whole range.
 */
export function faderHtml(id: string, label: string, text: string): string {
  return `
    <div class="rack-fader" data-fader="${escapeAttr(id)}" role="slider" tabindex="0"
      aria-label="${escapeAttr(label)}" aria-valuemin="0" aria-valuemax="100">
      <span class="fader-text" data-fader-text>${escapeHtml(text)}</span>
      <span class="fader-track" data-track><span class="fader-zero"></span><span class="fader-cap" data-cap></span></span>
      <span class="fader-label">${escapeHtml(label)}</span>
    </div>`;
}

export function bindFader(fader: HTMLElement, scale: Scale, start: number, fallback: number, io: ParamIO): void {
  const track = fader.querySelector<HTMLElement>('[data-track]');
  const cap = fader.querySelector<HTMLElement>('[data-cap]');
  let value = start;
  const paint = () => {
    const position = scale.toPosition(value);
    if (cap) cap.style.bottom = `calc(${(position * 100).toFixed(2)}% - 7px)`;
    fader.setAttribute('aria-valuenow', String(Math.round(position * 100)));
  };
  const setValue = (next: number) => {
    value = next;
    paint();
    io.set(value);
  };
  const fromPointer = (clientY: number) => {
    if (!track) return;
    const box = track.getBoundingClientRect();
    setValue(scale.toValue(1 - (clientY - box.top) / box.height));
  };
  paint();
  onDrag(fader, { start: (e) => fromPointer(e.clientY), move: (e) => fromPointer(e.clientY) });
  fader.addEventListener('keydown', (e) => {
    const direction = e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : 0;
    if (!direction) return;
    e.preventDefault();
    setValue(scale.step(value, direction));
  });
  onDoubleTap(fader, () => setValue(fallback));
}

export function showFader(fader: HTMLElement, text: string): void {
  const label = fader.querySelector('[data-fader-text]');
  if (label) label.textContent = text;
}
