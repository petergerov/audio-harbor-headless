import { CollectionsView } from './collectionsView';
import { LibraryView } from './libraryView';
import { NowPlayingView } from './nowPlayingView';
import { SettingsView } from './settingsView';
import type { ViewRegistry } from './view';

export const VIEWS: ViewRegistry = {
  library: (ctx) => new LibraryView(ctx),
  collections: (ctx) => new CollectionsView(ctx),
  now: (ctx) => new NowPlayingView(ctx),
  settings: (ctx) => new SettingsView(ctx),
};
