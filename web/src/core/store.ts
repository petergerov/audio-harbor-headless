export type Listener<T> = (state: T, previous: T) => void;

/** The single source of truth: immutable updates, listeners hear each change with the state before it. */
export class Store<T extends object> {
  private readonly listeners = new Set<Listener<T>>();

  constructor(private state: T) {}

  get(): T {
    return this.state;
  }

  /** Merges `change` (or what it returns for the current state) into a new state. */
  update(change: Partial<T> | ((state: T) => Partial<T>)): void {
    const previous = this.state;
    const patch = typeof change === 'function' ? change(previous) : change;
    this.state = { ...previous, ...patch };
    for (const listener of this.listeners) listener(this.state, previous);
  }

  subscribe(listener: Listener<T>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
