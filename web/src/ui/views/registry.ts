import { CollectionsView } from './collectionsView';
import { LibraryView } from './libraryView';
import { NowPlayingView } from './nowPlayingView';
import { RecordingsView } from './recordingsView';
import { SettingsView } from './settingsView';
import type { ViewRegistry } from './view';

export const VIEWS: ViewRegistry = {
  library: (ctx) => new LibraryView(ctx),
  collections: (ctx) => new CollectionsView(ctx),
  now: (ctx) => new NowPlayingView(ctx),
  recordings: (ctx) => new RecordingsView(ctx),
  settings: (ctx) => new SettingsView(ctx),
};
