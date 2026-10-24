import type { RackApi } from '../../api/rackApi';
import type { RackInsert, RackParam, RackSnapshot } from '../../api/types';
import { errorMessage } from '../../core/errors';
import { escapeAttr, escapeHtml } from '../../core/html';
import { icons } from '../icons';
import { showToast } from '../overlay';

/** A knob sends at most this often while dragged; the last value always goes. */
const PARAM_SEND_MS = 60;

/** What leaves the rack, amber while plugins shape the sound, and what that means. */
export function rackPathHtml(rack: RackSnapshot): string {
  const latency = rack.latencyMs ? ` · ${rack.latencyMs} ms` : '';
  return `
    <div class="rack-path">
      <span class="rack-path-label ${rack.path.lit ? 'is-lit' : ''}">${escapeHtml(rack.path.label)}${escapeHtml(latency)}</span>
      <p class="rack-path-note">${escapeHtml(rack.error ?? rack.path.note)}</p>
    </div>
  `;
}

/** One insert: its power key (lit = in circuit), name, and why it is not running. */
export function insertHeadHtml(insert: RackInsert, index: number): string {
  const on = !insert.bypassed;
  const sub = insert.error ?? (insert.loaded ? insert.vendor : `${insert.vendor} · not loaded`);
  return `
    <button type="button" class="rack-power ${on ? 'is-on' : ''}" data-power="${escapeAttr(insert.id)}"
      aria-pressed="${on}" aria-label="${escapeAttr(`${insert.name}: ${on ? 'in circuit' : 'bypassed'}`)}">${icons.power}</button>
    <span class="rack-slot">${index + 1}</span>
    <span class="rack-insert-text">
      <span class="rack-insert-name">${escapeHtml(insert.name)}</span>
      <span class="rack-insert-sub ${insert.error ? 'is-error' : ''}">${escapeHtml(sub)}</span>
    </span>
  `;
}

function step(param: RackParam): number {
  if (param.stepped) return 1;
  const span = param.max - param.min;
  return span > 0 ? span / 1000 : 0.001;
}

/** A parameter as a slider with the plugin's own text for its value. */
export function paramSliderHtml(insertId: string, param: RackParam, opts: { pin?: boolean; pinned?: boolean } = {}): string {
  const pin =
    opts.pin === undefined
      ? ''
      : `<button type="button" class="rack-pin ${opts.pinned ? 'is-on' : ''}" data-pin="${escapeAttr(param.id)}"
          aria-pressed="${Boolean(opts.pinned)}" aria-label="${escapeAttr(`Pin ${param.name} to the rack`)}">${icons.pin}</button>`;
  return `
    <div class="rack-param" data-param-row="${escapeAttr(param.id)}">
      <div class="rack-param-head">
        <span class="rack-param-name">${escapeHtml(param.name)}</span>
        <span class="rack-param-text" data-param-text="${escapeAttr(param.id)}">${escapeHtml(param.text)}</span>
        ${pin}
      </div>
      <input type="range" data-insert="${escapeAttr(insertId)}" data-param="${escapeAttr(param.id)}"
        min="${param.min}" max="${param.max}" step="${step(param)}" value="${param.value}"
        aria-label="${escapeAttr(param.name)}" />
    </div>
  `;
}

/**
 * Sliders under `root` change their parameter while dragged. Returns whether a slider is
 * held, so live repaints can wait until it is let go.
 */
export function bindParamSliders(root: HTMLElement, rack: RackApi): () => boolean {
  let held = 0;
  root.querySelectorAll<HTMLInputElement>('input[data-param]').forEach((slider) => {
    const insert = slider.dataset.insert ?? '';
    const param = slider.dataset.param ?? '';
    let timer: number | null = null;
    let lastSent = 0;
    let inFlight = false;
    let pending: number | null = null;
    const send = async () => {
      if (inFlight || pending === null) return;
      const value = pending;
      pending = null;
      inFlight = true;
      lastSent = Date.now();
      try {
        const result = await rack.setParam(insert, param, value);
        const text = root.querySelector(`[data-param-text="${CSS.escape(param)}"]`);
        if (text && result) text.textContent = result.text;
      } catch (err) {
        showToast(errorMessage(err, 'The plugin did not take that value'), { error: true });
      } finally {
        inFlight = false;
        if (pending !== null) void send();
      }
    };
    slider.addEventListener('input', () => {
      pending = Number(slider.value);
      if (timer !== null) return;
      const wait = Math.max(0, PARAM_SEND_MS - (Date.now() - lastSent));
      timer = window.setTimeout(() => {
        timer = null;
        void send();
      }, wait);
    });
    slider.addEventListener('pointerdown', () => (held += 1));
    const release = () => (held = Math.max(0, held - 1));
    slider.addEventListener('pointerup', release);
    slider.addEventListener('pointercancel', release);
  });
  return () => held > 0;
}

/** Power keys under `root` switch their insert in or out. */
export function bindPowerKeys(root: HTMLElement, rack: RackApi, current: () => RackSnapshot | null): void {
  root.querySelectorAll<HTMLButtonElement>('[data-power]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.dataset.power ?? '';
      const insert = current()?.inserts.find((i) => i.id === id);
      if (!insert) return;
      try {
        await rack.setInsertBypass(id, !insert.bypassed);
      } catch (err) {
        showToast(errorMessage(err, 'Could not switch the plugin'), { error: true });
      }
    });
  });
}
