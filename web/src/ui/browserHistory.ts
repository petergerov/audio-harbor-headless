import type { HistoryPort } from '../services/navigator';
import type { Route } from '../state/route';
import { closeOverlayFromHistory, connectOverlayHistory, type OverlayHistory } from './overlay';

/** What one history entry holds. */
interface Entry {
  id: string;
  route: Route;
  scroll: number;
}

interface SavedEntry extends Entry {
  harbor: 1;
  /** The entry of an open sheet, on top of the screen's own. */
  sheet?: boolean;
}

function savedEntry(value: unknown): SavedEntry | null {
  const entry = value as Partial<SavedEntry> | null;
  if (!entry || entry.harbor !== 1 || typeof entry.id !== 'string' || !entry.route?.tab) return null;
  return { harbor: 1, id: entry.id, route: entry.route, scroll: Number(entry.scroll) || 0, sheet: entry.sheet === true };
}

/**
 * The navigator's routes as browser history: back / forward buttons, the Android back key and the
 * Safari swipe step through the app; each entry keeps its scroll position. An open sheet has an
 * entry of its own on top, so the back key closes the sheet and the screen stays.
 */
export class BrowserHistory implements HistoryPort, OverlayHistory {
  /** The entries this page made (or found after a reload), and which one shows. */
  private entries: Entry[] = [];
  private index = 0;
  private count = 0;
  private readonly session = Math.random().toString(36).slice(2, 8);
  private readonly fromReload: SavedEntry | null;
  private readonly listeners: Array<(route: Route, scroll: number) => void> = [];
  /** A sheet's entry on top: open, or closed with its entry about to go. */
  private sheet: 'none' | 'open' | 'closing' = 'none';
  /** The pop that takes a closed sheet's entry away: nothing to do on screen. */
  private ignorePop = false;

  constructor() {
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    this.fromReload = savedEntry(history.state);
    window.addEventListener('popstate', (event) => this.popped(event.state));
    connectOverlayHistory(this);
  }

  openSheet(): void {
    // Closed and opened again in one go (one sheet leading to the next): the entry stays.
    if (this.sheet === 'closing') {
      this.sheet = 'open';
      return;
    }
    const base = this.entries[this.index];
    if (this.sheet === 'open' || !base) return;
    history.pushState({ ...this.saved(base), scroll: window.scrollY, sheet: true }, '');
    this.sheet = 'open';
  }

  closeSheet(): void {
    if (this.sheet !== 'open') return;
    this.sheet = 'closing';
    // After this task: an action that closes the sheet and moves on takes the entry over (push).
    window.setTimeout(() => {
      if (this.sheet !== 'closing') return;
      this.sheet = 'none';
      this.ignorePop = true;
      history.back();
    }, 0);
  }

  restored(): Route | null {
    return this.fromReload?.route ?? null;
  }

  push(route: Route, leavingScroll: number): void {
    const current = this.entries[this.index];
    // A sheet's entry on top (open, or just closed): the new entry takes its place.
    const onSheet = this.sheet !== 'none';
    this.sheet = 'none';
    if (current) {
      current.scroll = leavingScroll;
      if (!onSheet) history.replaceState(this.saved(current), '');
    }
    const entry: Entry = { id: this.newId(), route, scroll: 0 };
    this.entries = [...this.entries.slice(0, this.index + 1), entry];
    this.index = this.entries.length - 1;
    if (onSheet) history.replaceState(this.saved(entry), '');
    else history.pushState(this.saved(entry), '');
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
    // With a sheet on top, its entry carries the route too and stays a sheet's.
    const sheet = this.sheet === 'none' ? {} : { sheet: true };
    history.replaceState({ ...this.saved(current), ...sheet }, '');
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
    if (this.ignorePop) {
      this.ignorePop = false;
      return;
    }
    const saved = savedEntry(state);
    const base = this.entries[this.index];
    if (this.sheet !== 'none') {
      // The back key with a sheet open (or just closed): the sheet goes, the screen stays.
      const wasOpen = this.sheet === 'open';
      this.sheet = 'none';
      if (wasOpen) closeOverlayFromHistory();
      if (saved?.id === base?.id) return;
    }
    if (!saved) return; // Not one of ours (a bare #link).
    // Forward onto a closed sheet's entry: nothing to show.
    if (saved.sheet && saved.id === base?.id) return;
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
    closeOverlayFromHistory();
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
