import type { RackApi } from '../../api/rackApi';
import type { InsertMeter } from '../../api/types';

/** How often a panel asks for levels while it is open. */
const POLL_MS = 120;
/** The bars show -60…0 dBFS. */
const FLOOR_DB = -60;

/** In and out level of one insert, and the gain change between them. */
export function meterHtml(): string {
  return `
    <div class="rack-meter" data-meter>
      <div class="meter-row"><span>In</span><span class="meter-bar"><span data-meter-in></span></span><span class="meter-db" data-meter-in-db>–</span></div>
      <div class="meter-row"><span>Out</span><span class="meter-bar"><span data-meter-out></span></span><span class="meter-db" data-meter-out-db>–</span></div>
      <div class="meter-row gain"><span>Gain</span><span class="meter-bar centre"><span data-meter-gain></span></span><span class="meter-db" data-meter-gain-db>–</span></div>
    </div>`;
}

const width = (db: number) => `${Math.max(0, Math.min(1, (db - FLOOR_DB) / -FLOOR_DB)) * 100}%`;
const dbText = (db: number) => (db <= -119 ? '–∞' : `${db.toFixed(1)}`);

function paint(meter: HTMLElement, level: InsertMeter | undefined): void {
  const set = (sel: string, apply: (el: HTMLElement) => void) => {
    const el = meter.querySelector<HTMLElement>(sel);
    if (el) apply(el);
  };
  if (!level) return;
  // No signal: no gain change to show.
  const gain = level.in > -100 ? level.out - level.in : 0;
  set('[data-meter-in]', (el) => (el.style.width = width(level.in)));
  set('[data-meter-out]', (el) => (el.style.width = width(level.out)));
  set('[data-meter-in-db]', (el) => (el.textContent = dbText(level.in)));
  set('[data-meter-out-db]', (el) => (el.textContent = dbText(level.out)));
  // Gain: from the centre, left for reduction, right for boost; ±24 dB across.
  set('[data-meter-gain]', (el) => {
    const share = Math.min(1, Math.abs(gain) / 24) * 50;
    el.style.left = gain < 0 ? `${50 - share}%` : '50%';
    el.style.width = `${share}%`;
    el.classList.toggle('is-cut', gain < 0);
  });
  set('[data-meter-gain-db]', (el) => (el.textContent = `${gain > 0 ? '+' : ''}${gain.toFixed(1)}`));
}

/** Polls the levels while `meter` is on screen; stops by itself once it is gone. */
export function runMeter(meter: HTMLElement, rack: RackApi, insertId: string): void {
  const tick = async () => {
    try {
      paint(meter, (await rack.meters())[insertId]);
    } catch {
      // A missed reading is not worth a message.
    }
    if (meter.isConnected) window.setTimeout(() => void tick(), POLL_MS);
  };
  // First paint once the meter is in the page.
  window.setTimeout(() => void tick(), 0);
}
