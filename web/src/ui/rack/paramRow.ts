import { escapeAttr, escapeHtml } from '../../core/html';
import { icons } from '../icons';
import { CONTROLS, type ParamIO } from './paramControls';
import type { ParamView } from './paramModel';

/** Holding the name this long pins (or unpins) the parameter. */
const LONG_PRESS_MS = 500;

export interface RowOptions {
  /** Show the pin star; `pinned` is its state. */
  pinnable: boolean;
  pinned?: boolean;
  /** The name to show when the group already says part of it; the plugin's name otherwise. */
  label?: string;
}

/** A parameter: its name and the control for its kind beside it, the rest of the control below. */
export function paramRowHtml(view: ParamView, opts: RowOptions): string {
  const control = CONTROLS[view.kind];
  const { param } = view;
  const pin = opts.pinnable
    ? `<button type="button" class="rack-pin ${opts.pinned ? 'is-on' : ''}" data-pin
        aria-pressed="${Boolean(opts.pinned)}" aria-label="${escapeAttr(`Pin ${param.name} to the rack sheet`)}">${icons.pin}</button>`
    : '';
  return `
    <div class="param-row kind-${view.kind}" data-param-row="${escapeAttr(param.id)}">
      <div class="param-head">
        <span class="param-name" data-name>${escapeHtml(opts.label ?? param.name)}</span>
        ${control.head(view)}
        ${pin}
      </div>
      ${control.body(view)}
    </div>`;
}

/** Wires the control, and the star and a long press on the name to `onPin`. */
export function bindParamRow(row: HTMLElement, view: ParamView, io: ParamIO, onPin?: () => void): void {
  CONTROLS[view.kind].bind(row, view, io);
  if (!onPin) return;
  row.querySelector('[data-pin]')?.addEventListener('click', onPin);
  const name = row.querySelector<HTMLElement>('[data-name]');
  if (!name) return;
  let timer: number | null = null;
  const cancel = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  };
  name.addEventListener('pointerdown', () => {
    cancel();
    timer = window.setTimeout(() => {
      timer = null;
      navigator.vibrate?.(10);
      onPin();
    }, LONG_PRESS_MS);
  });
  name.addEventListener('pointerup', cancel);
  name.addEventListener('pointerleave', cancel);
  name.addEventListener('pointercancel', cancel);
}
