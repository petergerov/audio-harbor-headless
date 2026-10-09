import type { PlayContext } from '../../api/types';
import type { Store } from '../../core/store';
import type { CollectionsService } from '../../services/collectionsService';
import type { Navigation } from '../../services/navigator';
import type { AppState } from '../../state/appState';

/** What the organize sheets work with. */
export interface SheetDeps {
  store: Store<AppState>;
  collections: CollectionsService;
  nav: Navigation;
  /** Plays and closes any open sheet. */
  play(context: PlayContext): Promise<void>;
}
