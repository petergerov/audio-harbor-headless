import type { SettingsApi } from '../api/settingsApi';
import type { Store } from '../core/store';
import type { CollectionsService } from '../services/collectionsService';
import type { Navigation } from '../services/navigator';
import type { PlaybackClock } from '../services/playbackClock';
import type { PlaybackActions } from '../services/playbackService';
import type { HostSettings } from '../services/settingsService';
import type { AppState } from '../state/appState';
import type { Covers } from '../ui/components/covers';
import type { PlayerBindings } from '../ui/components/playerBindings';
import type { ItemActions } from '../ui/sheets/itemActions';

/** What screens depend on: abstractions, wired up once in main.ts. */
export interface AppContext {
  store: Store<AppState>;
  nav: Navigation;
  playback: PlaybackActions;
  clock: PlaybackClock;
  collections: CollectionsService;
  settings: SettingsApi;
  /** The Settings snapshot the iOS app shares (sharing, scanning, about), kept in the store. */
  hostSettings: HostSettings;
  covers: Covers;
  bindings: PlayerBindings;
  actions: ItemActions;
}
