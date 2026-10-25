/** One way to show an insert's parameters in its sheet: its own panel, or the full list. */
export interface InsertView {
  mount(container: HTMLElement): Promise<void>;
  /** The plugin's values changed from outside the view (undo, compare, reset): draw them again. */
  reload(): Promise<void>;
}
