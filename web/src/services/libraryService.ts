import type { LibraryApi } from '../api/libraryApi';
import type { Store } from '../core/store';
import type { AppState } from '../state/appState';
import { drillPath } from '../state/selectors';

/** Fills the library list for the library as the state describes it. */
export class LibraryService {
  private loads = 0;

  constructor(
    private readonly api: LibraryApi,
    private readonly store: Store<AppState>
  ) {}

  /** Search hits when there is a query, else the browsed level. The latest call wins. */
  async load(): Promise<void> {
    const ticket = ++this.loads;
    const library = this.store.get().library;
    const query = library.query.trim();
    const items = query
      ? await this.api.search(query)
      : await this.api.browse(library.scope, drillPath(library));
    if (ticket !== this.loads) return;
    this.store.update((state) => ({ library: { ...state.library, items } }));
  }
}
