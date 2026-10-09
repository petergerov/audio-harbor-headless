import type { AppContext } from '../../app/context';
import type { Tab } from '../../state/appState';

/** What the shell offers the screen it hosts. */
export interface ViewHost {
  /** Markup for the compact header player, empty when the layout has none. */
  headerPlayerSlot(): string;
}

/** One screen inside the shell. */
export interface View {
  render(root: HTMLElement, host: ViewHost): void | Promise<void>;
  /** Another track plays (same layout): refresh what shows it. */
  onTrackChange?(): void;
  /** The shell leaves this screen: stop timers. */
  dispose?(): void;
}

export type ViewFactory = (ctx: AppContext) => View;

/** One screen per tab — a new tab is a new entry, the shell stays as it is. */
export type ViewRegistry = Record<Tab, ViewFactory>;
