import { errorMessage } from '../../core/errors';
import { escapeAttr, escapeHtml } from '../../core/html';
import { showToast } from '../overlay';
import type { ControlKind, ParamView } from './paramModel';

/** Positions a slider can take; the scale maps them to the plugin's values. */
const SLIDER_STEPS = 1000;
/** Two taps within this many ms are a double tap. */
const DOUBLE_TAP_MS = 300;

/** What a control may do with its parameter. */
export interface ParamIO {
  /** A new value in the plugin's units (sent throttled). */
  set(value: number): void;
  /** Text the plugin reads ("-3.5 dB"); rejects when it does not. */
  setText(text: string): Promise<void>;
}

/**
 * One way to operate a parameter. The row puts `head` beside the name and `body` below it;
 * `show` reflects a value the plugin reported without rebuilding the control.
 */
export interface ParamControl {
  head(view: ParamView): string;
  body(view: ParamView): string;
  bind(row: HTMLElement, view: ParamView, io: ParamIO): void;
  show(row: HTMLElement, view: ParamView): void;
}

/** Double tap (touch) or double click (mouse) on `el`. */
export function onDoubleTap(el: HTMLElement, run: () => void): void {
  let last = 0;
  el.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'mouse') return;
    const now = Date.now();
    if (now - last < DOUBLE_TAP_MS) run();
    last = now;
  });
  el.addEventListener('dblclick', run);
}

const toggleControl: ParamControl = {
  head: ({ param }) =>
    `<input type="checkbox" role="switch" class="switch" data-toggle ${param.value >= param.max ? 'checked' : ''}
      aria-label="${escapeAttr(param.name)}" />`,
  body: () => '',
  bind(row, { param }, io) {
    row.querySelector<HTMLInputElement>('[data-toggle]')?.addEventListener('change', (e) => {
      io.set((e.target as HTMLInputElement).checked ? param.max : param.min);
    });
  },
  show(row, { param }) {
    const input = row.querySelector<HTMLInputElement>('[data-toggle]');
    if (input) input.checked = param.value >= param.max;
  },
};

const choiceControl: ParamControl = {
  head: ({ param }) => `
    <select class="param-choice" data-choice aria-label="${escapeAttr(param.name)}">
      ${(param.options ?? [])
        .map((o) => `<option value="${o.value}" ${o.value === param.value ? 'selected' : ''}>${escapeHtml(o.text)}</option>`)
        .join('')}
    </select>`,
  body: () => '',
  bind(row, _view, io) {
    row.querySelector<HTMLSelectElement>('[data-choice]')?.addEventListener('change', (e) => {
      io.set(Number((e.target as HTMLSelectElement).value));
    });
  },
  show(row, { param }) {
    const select = row.querySelector<HTMLSelectElement>('[data-choice]');
    if (select) select.value = String(param.value);
  },
};

/** A slider on the parameter's scale, − / + for fine steps, the value to tap and type. */
const numberControl: ParamControl = {
  head: ({ param }) =>
    `<button type="button" class="param-value" data-value aria-label="${escapeAttr(`Type a value for ${param.name}`)}">${escapeHtml(param.text)}</button>`,
  body: ({ param, scale }) => `
    <div class="param-number">
      <button type="button" class="param-step" data-step="-1" aria-label="${escapeAttr(`Less ${param.name}`)}">−</button>
      <input type="range" data-slider min="0" max="${SLIDER_STEPS}" step="1"
        value="${Math.round(scale.toPosition(param.value) * SLIDER_STEPS)}" aria-label="${escapeAttr(param.name)}" />
      <button type="button" class="param-step" data-step="1" aria-label="${escapeAttr(`More ${param.name}`)}">+</button>
    </div>`,
  bind(row, view, io) {
    const { param, scale } = view;
    const slider = row.querySelector<HTMLInputElement>('[data-slider]');
    // The value as last set here or reported by the plugin; the row carries it between the two.
    row.dataset.current = String(param.value);
    const current = () => Number(row.dataset.current);
    const set = (value: number) => {
      row.dataset.current = String(value);
      io.set(value);
    };
    const apply = (value: number) => {
      if (slider) slider.value = String(Math.round(scale.toPosition(value) * SLIDER_STEPS));
      set(value);
    };
    slider?.addEventListener('input', () => {
      const value = scale.toValue(Number(slider.value) / SLIDER_STEPS);
      set(param.stepped ? Math.round(value) : value);
    });
    if (slider) onDoubleTap(slider, () => apply(param.default));
    row.querySelectorAll<HTMLButtonElement>('[data-step]').forEach((button) => {
      button.addEventListener('click', () => apply(scale.step(current(), Number(button.dataset.step) as -1 | 1)));
    });
    row.querySelector<HTMLButtonElement>('[data-value]')?.addEventListener('click', (e) =>
      editValue(e.currentTarget as HTMLButtonElement, param, io, () => apply(param.default))
    );
  },
  show(row, { param, scale }) {
    row.dataset.current = String(param.value);
    const value = row.querySelector('[data-value]');
    if (value) value.textContent = param.text;
    // A slider under the finger stays where the finger is.
    const slider = row.querySelector<HTMLInputElement>('[data-slider]');
    if (slider && document.activeElement !== slider) {
      slider.value = String(Math.round(scale.toPosition(param.value) * SLIDER_STEPS));
    }
  },
};

/** The value button becomes a field: Enter sets what was typed, Escape or leaving cancels. */
function editValue(button: HTMLButtonElement, param: ParamView['param'], io: ParamIO, reset: () => void): void {
  const field = document.createElement('span');
  field.className = 'param-edit';
  field.innerHTML = `
    <input type="text" enterkeyhint="done" autocomplete="off" value="${escapeAttr(param.text)}"
      aria-label="${escapeAttr(`${param.name}, in the plugin's units`)}" />
    <button type="button" class="param-reset" aria-label="${escapeAttr(`Reset ${param.name}`)}">Default</button>`;
  const input = field.querySelector('input') as HTMLInputElement;
  const close = () => field.replaceWith(button);
  let done = false;
  const finish = async (commit: boolean) => {
    if (done) return;
    done = true;
    const typed = input.value.trim();
    // The button goes back first, so the plugin's answer lands on it.
    close();
    if (!commit || !typed || typed === param.text) return;
    try {
      await io.setText(typed);
    } catch (err) {
      showToast(errorMessage(err, 'Not a value this plugin reads'), { error: true });
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void finish(true);
    if (e.key === 'Escape') void finish(false);
  });
  input.addEventListener('blur', () => window.setTimeout(() => void finish(true), 150));
  field.querySelector('.param-reset')?.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    done = true;
    reset();
    close();
  });
  button.replaceWith(field);
  input.focus();
  input.select();
}

/** The control for each kind — a new kind of control is a new entry here. */
export const CONTROLS: Record<ControlKind, ParamControl> = {
  toggle: toggleControl,
  choice: choiceControl,
  number: numberControl,
};
