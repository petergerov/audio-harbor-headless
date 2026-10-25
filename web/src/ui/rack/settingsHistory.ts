import type { RackApi } from '../../api/rackApi';

/** Changes this close together are one step to undo (a drag, a few taps on +). */
const SETTLE_MS = 800;
const MAX_UNDO = 30;

/**
 * One insert's settings while its sheet is open: undo step by step, compare with how they
 * were when the sheet opened, and reset to the plugin's defaults. Works on the plugin's whole
 * state, so it covers every kind of control alike.
 */
export class SettingsHistory {
  private opened: string | null = null;
  private settled: string | null = null;
  private undoStack: string[] = [];
  private comparing: string | null = null;
  private settleTimer: number | null = null;
  private settling: Promise<void> | null = null;

  constructor(
    private readonly rack: RackApi,
    private readonly insertId: string,
    /** The plugin's values changed from here (undo, compare, reset): the controls redraw. */
    private readonly onRestore: () => void,
    /** What can be done changed: the buttons redraw. */
    private readonly onState: () => void
  ) {}

  /** Remembers the settings as the sheet opens. False when the plugin keeps no state. */
  async start(): Promise<boolean> {
    try {
      this.opened = this.settled = await this.rack.state(this.insertId);
      return true;
    } catch {
      return false;
    }
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0 || this.settleTimer !== null;
  }

  get isComparing(): boolean {
    return this.comparing !== null;
  }

  /** The listener changed something: a step is taken once the changes settle. */
  changed(): void {
    // Editing while comparing keeps the opened settings as the new current ones.
    this.comparing = null;
    if (this.settleTimer !== null) window.clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => {
      this.settleTimer = null;
      void this.settle();
    }, SETTLE_MS);
    this.onState();
  }

  async undo(): Promise<void> {
    await this.settleNow();
    const previous = this.undoStack.pop();
    if (!previous) return;
    await this.restore(previous);
    this.settled = previous;
  }

  /** Before ↔ now: the settings from when the sheet opened, and back. */
  async toggleCompare(): Promise<void> {
    if (!this.opened) return;
    await this.settleNow();
    if (this.comparing === null) {
      this.comparing = this.settled ?? (await this.rack.state(this.insertId));
      await this.restore(this.opened);
    } else {
      const back = this.comparing;
      this.comparing = null;
      await this.restore(back);
    }
  }

  /** Every parameter to its default — one step to undo. */
  async reset(): Promise<void> {
    await this.settleNow();
    if (this.settled) this.push(this.settled);
    this.comparing = null;
    await this.rack.reset(this.insertId);
    this.settled = await this.rack.state(this.insertId);
    this.onRestore();
    this.onState();
  }

  private async restore(state: string): Promise<void> {
    await this.rack.setState(this.insertId, state);
    this.onRestore();
    this.onState();
  }

  private async settleNow(): Promise<void> {
    if (this.settleTimer !== null) {
      window.clearTimeout(this.settleTimer);
      this.settleTimer = null;
      await this.settle();
    }
    await this.settling;
  }

  private settle(): Promise<void> {
    this.settling = (async () => {
      const now = await this.rack.state(this.insertId);
      if (now !== this.settled && this.settled) this.push(this.settled);
      this.settled = now;
      this.onState();
    })().catch(() => {});
    return this.settling;
  }

  private push(state: string): void {
    this.undoStack.push(state);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
  }
}
