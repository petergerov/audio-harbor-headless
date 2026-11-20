import type { CollectionKind, PlayContext, Selection } from '../../api/types';
import { haptic } from '../../core/device';
import { errorMessage } from '../../core/errors';
import type { Store } from '../../core/store';
import type { CollectionsService } from '../../services/collectionsService';
import type { Navigation } from '../../services/navigator';
import type { PlaybackActions } from '../../services/playbackService';
import type { SettingsApi } from '../../api/settingsApi';
import type { AppState, OpenCollection } from '../../state/appState';
import type { Picks } from '../../state/picks';
import { closeOverlay, showToast } from '../overlay';
import { openCollectionMenu, openNewPlaylist } from './collectionMenu';
import { openExportPlaylists } from './exportPlaylists';
import { openOrganize } from './organizeSheet';
import { openPicksLabels } from './picksLabels';
import { openPicksPicker } from './picksPicker';
import { removeSongs } from './removeSongs';
import type { SheetDeps } from './sheetDeps';

/** What a screen can do with an item beyond navigating: play it, organize it, manage collections. */
export interface ItemActions {
  /** Plays without leaving the screen (no jump to Now Playing). */
  play(context: PlayContext): Promise<void>;
  organize(selection: Selection, inCollection: OpenCollection | null): void;
  manageCollection(kind: CollectionKind, id: string, name: string): void;
  createPlaylist(): void;
  /** Add to Playlist for the songs ticked in Catalogue. */
  addPicksToPlaylist(): void;
  /** Labels for the ticked songs: put one on all of them, or take it off. */
  labelPicks(): void;
  /** Takes the ticked songs in `paths` out of the open playlist or label, with Undo; Select ends. */
  removePicks(collection: OpenCollection, paths: string[]): Promise<void>;
  /** Every playlist as an M3U8 file into a folder on the host. */
  exportPlaylists(): void;
}

export class SheetActions implements ItemActions {
  private readonly sheets: SheetDeps;
  private readonly picks: Picks;
  private readonly settings: SettingsApi;

  constructor(deps: {
    store: Store<AppState>;
    collections: CollectionsService;
    nav: Navigation;
    playback: PlaybackActions;
    picks: Picks;
    settings: SettingsApi;
  }) {
    this.picks = deps.picks;
    this.settings = deps.settings;
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

  addPicksToPlaylist(): void {
    void openPicksPicker(this.picks, this.sheets);
  }

  labelPicks(): void {
    void openPicksLabels(
      this.picks.state.tracks.map((t) => t.cataloguePath),
      this.sheets
    );
  }

  async removePicks(collection: OpenCollection, paths: string[]): Promise<void> {
    if (await removeSongs(collection, paths, this.sheets)) this.picks.end();
  }

  exportPlaylists(): void {
    openExportPlaylists(this.settings, this.sheets);
  }
}
