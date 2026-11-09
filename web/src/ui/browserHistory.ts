import type { HistoryPort } from '../services/navigator';
import type { Route } from '../state/route';
import { closeOverlay } from './overlay';

/** What one history entry holds. */
interface Entry {
  id: string;
  route: Route;
  scroll: number;
}

interface SavedEntry extends Entry {
  harbor: 1;
}

function savedEntry(value: unknown): SavedEntry | null {
  const entry = value as Partial<SavedEntry> | null;
  if (!entry || entry.harbor !== 1 || typeof entry.id !== 'string' || !entry.route?.tab) return null;
  return { harbor: 1, id: entry.id, route: entry.route, scroll: Number(entry.scroll) || 0 };
}

/**
 * The navigator's routes as browser history: back / forward buttons, the Android back key and the
 * Safari swipe step through the app; each entry keeps its scroll position.
 */
export class BrowserHistory implements HistoryPort {
  /** The entries this page made (or found after a reload), and which one shows. */
  private entries: Entry[] = [];
  private index = 0;
  private count = 0;
  private readonly session = Math.random().toString(36).slice(2, 8);
  private readonly fromReload: SavedEntry | null;
  private readonly listeners: Array<(route: Route, scroll: number) => void> = [];

  constructor() {
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    this.fromReload = savedEntry(history.state);
    window.addEventListener('popstate', (event) => this.popped(event.state));
  }

  restored(): Route | null {
    return this.fromReload?.route ?? null;
  }

  push(route: Route, leavingScroll: number): void {
    const current = this.entries[this.index];
    if (current) {
      current.scroll = leavingScroll;
      history.replaceState(this.saved(current), '');
    }
    const entry: Entry = { id: this.newId(), route, scroll: 0 };
    this.entries = [...this.entries.slice(0, this.index + 1), entry];
    this.index = this.entries.length - 1;
    history.pushState(this.saved(entry), '');
  }

  replace(route: Route): void {
    let current = this.entries[this.index];
    if (current) {
      current.route = route;
    } else {
      current = { id: this.fromReload?.id ?? this.newId(), route, scroll: this.fromReload?.scroll ?? 0 };
      this.entries = [current];
      this.index = 0;
    }
    history.replaceState(this.saved(current), '');
  }

  back(): void {
    history.back();
  }

  previous(): Route | null {
    return this.entries[this.index - 1]?.route ?? null;
  }

  onPop(listener: (route: Route, scroll: number) => void): void {
    this.listeners.push(listener);
  }

  scrollY(): number {
    return window.scrollY;
  }

  scrollTo(y: number, smooth = false): void {
    window.scrollTo({ top: y, behavior: smooth ? 'smooth' : 'instant' });
  }

  private popped(state: unknown): void {
    const saved = savedEntry(state);
    if (!saved) return; // Not one of ours (a bare #link).
    const leaving = this.entries[this.index];
    if (leaving) leaving.scroll = window.scrollY;
    const at = this.entries.findIndex((entry) => entry.id === saved.id);
    if (at >= 0) {
      this.index = at;
    } else {
      // An entry from before a reload: what it saved is all there is.
      this.entries = [{ id: saved.id, route: saved.route, scroll: saved.scroll }];
      this.index = 0;
    }
    // A sheet belongs to the screen it was opened on.
    closeOverlay();
    const entry = this.entries[this.index]!;
    for (const listener of this.listeners) listener(entry.route, entry.scroll);
  }

  private newId(): string {
    return `${this.session}:${++this.count}`;
  }

  private saved(entry: Entry): SavedEntry {
    return { harbor: 1, id: entry.id, route: entry.route, scroll: entry.scroll };
  }
}
