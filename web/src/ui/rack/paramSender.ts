import type { RackApi } from '../../api/rackApi';
import type { RackParam } from '../../api/types';
import { errorMessage } from '../../core/errors';
import { showToast } from '../overlay';

/** A dragged control sends at most this often; the last value always goes. */
const SEND_MS = 60;

interface Pending {
  value: number | null;
  timer: number | null;
  inFlight: boolean;
  lastSent: number;
}

/**
 * Sends one insert's parameter changes to the host — throttled per parameter while a control
 * moves — and hands every answer (the value as the plugin took it, with its text) back.
 */
export class ParamSender {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly rack: RackApi,
    private readonly insertId: string,
    private readonly onAnswer: (param: RackParam) => void
  ) {}

  set(paramId: string, value: number): void {
    const state = this.state(paramId);
    state.value = value;
    if (state.timer !== null) return;
    const wait = Math.max(0, SEND_MS - (Date.now() - state.lastSent));
    state.timer = window.setTimeout(() => {
      state.timer = null;
      void this.flush(paramId, state);
    }, wait);
  }

  /** Typed in the plugin's units; rejects with the plugin's refusal. */
  async setText(paramId: string, text: string): Promise<void> {
    const answer = await this.rack.setParamText(this.insertId, paramId, text);
    if (answer) this.onAnswer(answer);
  }

  private state(paramId: string): Pending {
    let state = this.pending.get(paramId);
    if (!state) {
      state = { value: null, timer: null, inFlight: false, lastSent: 0 };
      this.pending.set(paramId, state);
    }
    return state;
  }

  private async flush(paramId: string, state: Pending): Promise<void> {
    if (state.inFlight || state.value === null) return;
    const value = state.value;
    state.value = null;
    state.inFlight = true;
    state.lastSent = Date.now();
    try {
      const answer = await this.rack.setParam(this.insertId, paramId, value);
      if (answer) this.onAnswer(answer);
    } catch (err) {
      showToast(errorMessage(err, 'The plugin did not take that value'), { error: true });
    } finally {
      state.inFlight = false;
      if (state.value !== null) void this.flush(paramId, state);
    }
  }
}

/**
 * Whether a pointer went down on a control under `root` and is not up yet (it may come up
 * anywhere) — live repaints wait until it is.
 */
export function trackHolds(root: HTMLElement): () => boolean {
  let held = false;
  const release = () => {
    held = false;
    if (root.isConnected) return;
    window.removeEventListener('pointerup', release);
    window.removeEventListener('pointercancel', release);
  };
  root.addEventListener('pointerdown', () => (held = true));
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);
  return () => held && root.isConnected;
}
