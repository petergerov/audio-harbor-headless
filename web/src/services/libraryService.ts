import type { LibraryApi } from '../api/libraryApi';
import type { BrowseItem } from '../api/types';
import { errorMessage } from '../core/errors';
import type { Store } from '../core/store';
import type { AppState, LibraryState } from '../state/appState';
import { drillPath } from '../state/selectors';

/** How many browsed levels and searches stay at hand for an instant back. */
const CACHE_SIZE = 40;

/** One key per level or search: what the host would answer the same. */
function keyOf(library: LibraryState): string {
  const query = library.query.trim();
  return query ? `q:${query}` : `${library.scope}:${drillPath(library) ?? ''}`;
}

function sameItems(a: BrowseItem[], b: BrowseItem[]): boolean {
  return a === b || (a.length === b.length && JSON.stringify(a) === JSON.stringify(b));
}

/**
 * Fills the library list for the library as the state describes it. Levels seen before show at
 * once from memory and are checked with the host behind them (stale-while-revalidate).
 */
export class LibraryService {
  private loads = 0;
  private readonly cache = new Map<string, BrowseItem[]>();

  constructor(
    private readonly api: LibraryApi,
    private readonly store: Store<AppState>
  ) {}

  /**
   * Shows what is known for the level in the state, before asking the host: its items from memory,
   * or placeholders. With `keepOnMiss` (a search being typed) the list on screen stays instead.
   * True when the items came from memory.
   */
  prime(options: { keepOnMiss?: boolean } = {}): boolean {
    const cached = this.cache.get(keyOf(this.store.get().library));
    if (!cached && options.keepOnMiss) return false;
    this.store.update((state) => ({
      library: { ...state.library, items: cached ?? [], loading: !cached, error: null },
    }));
    return Boolean(cached);
  }

  /** Search hits when there is a query, else the browsed level. The latest call wins. */
  async load(): Promise<void> {
    const ticket = ++this.loads;
    const library = this.store.get().library;
    const key = keyOf(library);
    const query = library.query.trim();
    let items: BrowseItem[];
    try {
      items = query ? await this.api.search(query) : await this.api.browse(library.scope, drillPath(library));
    } catch (err) {
      if (ticket === this.loads) {
        // Items already on screen stay; an empty level says why it is empty.
        this.store.update((state) => ({
          library: {
            ...state.library,
            loading: false,
            error: state.library.items.length ? null : errorMessage(err, 'Could not load the library'),
          },
        }));
      }
      throw err;
    }
    this.remember(key, items);
    if (ticket !== this.loads) return;
    this.store.update((state) => {
      const current = state.library;
      // The same answer as on screen: no repaint, the list keeps its covers and scroll.
      const unchanged = sameItems(current.items, items);
      if (unchanged && !current.loading && !current.error) return {};
      return { library: { ...current, items: unchanged ? current.items : items, loading: false, error: null } };
    });
  }

  /** Drops what memory holds (the catalogue changed: a scan ended, a source came or went). */
  invalidate(): void {
    this.cache.clear();
  }

  private remember(key: string, items: BrowseItem[]): void {
    this.cache.delete(key);
    this.cache.set(key, items);
    if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
  }
}
