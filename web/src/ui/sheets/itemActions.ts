import type { CollectionKind, PlayContext, Selection } from '../../api/types';
import { haptic } from '../../core/device';
import { errorMessage } from '../../core/errors';
import type { Store } from '../../core/store';
import type { CollectionsService } from '../../services/collectionsService';
import type { Navigation } from '../../services/navigator';
import type { PlaybackActions } from '../../services/playbackService';
import type { AppState, OpenCollection } from '../../state/appState';
import { closeOverlay, showToast } from '../overlay';
import { openCollectionMenu, openNewPlaylist } from './collectionMenu';
import { openOrganize } from './organizeSheet';
import type { SheetDeps } from './sheetDeps';

/** What a screen can do with an item beyond navigating: play it, organize it, manage collections. */
export interface ItemActions {
  /** Plays without leaving the screen (no jump to Now Playing). */
  play(context: PlayContext): Promise<void>;
  organize(selection: Selection, inCollection: OpenCollection | null): void;
  manageCollection(kind: CollectionKind, id: string, name: string): void;
  createPlaylist(): void;
}

export class SheetActions implements ItemActions {
  private readonly sheets: SheetDeps;

  constructor(deps: {
    store: Store<AppState>;
    collections: CollectionsService;
    nav: Navigation;
    playback: PlaybackActions;
  }) {
    this.sheets = {
      store: deps.store,
      collections: deps.collections,
      nav: deps.nav,
      play: async (context) => {
        haptic('medium');
        closeOverlay();
        try {
          await deps.playback.play(context);
        } catch (err) {
          showToast(errorMessage(err, 'Could not play'), { error: true });
        }
      },
    };
  }

  play(context: PlayContext): Promise<void> {
    return this.sheets.play(context);
  }

  organize(selection: Selection, inCollection: OpenCollection | null): void {
    openOrganize(selection, inCollection, this.sheets);
  }

  manageCollection(kind: CollectionKind, id: string, name: string): void {
    openCollectionMenu(kind, id, name, this.sheets);
  }

  createPlaylist(): void {
    openNewPlaylist(this.sheets);
  }
}
