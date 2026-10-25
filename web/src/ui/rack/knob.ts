import { escapeAttr, escapeHtml } from '../../core/html';
import type { RackParam } from '../../api/types';
import { onDrag } from './drag';
import { onDoubleTap, type ParamIO } from './paramControls';
import type { ParamView } from './paramModel';

/** The arc a knob turns through, in degrees from 12 o'clock: 7:30 to 4:30. */
const START = -135;
const SWEEP = 270;
/** Dragging this many pixels up turns the knob from left stop to right stop. */
const TRAVEL_PX = 180;
const R = 22;
const C = 28;

function point(deg: number, r: number): string {
  const rad = ((deg - 90) * Math.PI) / 180;
  return `${(C + r * Math.cos(rad)).toFixed(2)} ${(C + r * Math.sin(rad)).toFixed(2)}`;
}

function arc(from: number, to: number): string {
  const large = to - from > 180 ? 1 : 0;
  return `M ${point(from, R)} A ${R} ${R} 0 ${large} 1 ${point(to, R)}`;
}

function paint(knob: HTMLElement, position: number): void {
  const deg = START + SWEEP * Math.min(1, Math.max(0, position));
  knob.querySelector('[data-arc]')?.setAttribute('d', position > 0.002 ? arc(START, deg) : '');
  knob.querySelector('[data-pointer]')?.setAttribute('d', `M ${point(deg, R - 12)} L ${point(deg, R - 3)}`);
  knob.setAttribute('aria-valuenow', String(Math.round(position * 100)));
}

/** A rotary knob: drag up or down, double tap for the default. `label` replaces the plugin's name. */
export function knobHtml({ param }: ParamView, label: string = param.name): string {
  return `
    <div class="rack-knob" data-knob="${escapeAttr(param.id)}" role="slider" tabindex="0"
      aria-label="${escapeAttr(param.name)}" aria-valuemin="0" aria-valuemax="100">
      <svg viewBox="0 0 56 56" aria-hidden="true">
        <path class="knob-track" d="${arc(START, START + SWEEP)}" />
        <path class="knob-arc" data-arc d="" />
        <circle class="knob-cap" cx="${C}" cy="${C}" r="${R - 5}" />
        <path class="knob-pointer" data-pointer d="" />
      </svg>
      <span class="knob-text" data-knob-text>${escapeHtml(param.text)}</span>
      <span class="knob-name">${escapeHtml(label)}</span>
    </div>`;
}

export function bindKnob(knob: HTMLElement, view: ParamView, io: ParamIO): void {
  const { param, scale } = view;
  let value = param.value;
  paint(knob, scale.toPosition(value));
  const setValue = (next: number) => {
    value = param.stepped ? Math.round(next) : next;
    paint(knob, scale.toPosition(value));
    io.set(value);
  };
  // Dragging goes through the scale (and its detent); keys and double tap set values.
  const setPosition = (position: number) => setValue(scale.toValue(position));
  let startY = 0;
  let startPos = 0;
  onDrag(knob, {
    start: (e) => {
      startY = e.clientY;
      startPos = scale.toPosition(value);
    },
    move: (e) => setPosition(startPos + (startY - e.clientY) / TRAVEL_PX),
  });
  knob.addEventListener('keydown', (e) => {
    const direction = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -1 : 0;
    if (!direction) return;
    e.preventDefault();
    setValue(scale.step(value, direction));
  });
  onDoubleTap(knob, () => setValue(param.default));
}

/** The plugin's answer: its text under the knob (the knob itself stays where the hand left it). */
export function showKnob(knob: HTMLElement, answer: RackParam): void {
  const text = knob.querySelector('[data-knob-text]');
  if (text) text.textContent = answer.text;
}
