/**
 * Composition root: the only place that knows the concrete classes. Everything below depends on
 * the interfaces it is handed here.
 */
import './styles.css';
import { App } from './app/app';
import type { AppContext } from './app/context';
import { HttpArtworkApi } from './api/artworkApi';
import { HttpAuthApi } from './api/authApi';
import { HttpCollectionsApi } from './api/collectionsApi';
import { HttpClient, LocalTokenStore } from './api/http';
import { HttpLibraryApi } from './api/libraryApi';
import { LiveUpdates } from './api/liveUpdates';
import { HttpPlaybackApi } from './api/playbackApi';
import { HttpSettingsApi } from './api/settingsApi';
import { required } from './core/html';
import { Store } from './core/store';
import { CollectionsService } from './services/collectionsService';
import { LibraryService } from './services/libraryService';
import { Navigator } from './services/navigator';
import { PlaybackClock } from './services/playbackClock';
import { PlaybackService } from './services/playbackService';
import { initialState, type AppState } from './state/appState';
import { Covers } from './ui/components/covers';
import { PlayerBindings } from './ui/components/playerBindings';
import { HeaderPlayer, MiniPlayer, NowBar } from './ui/components/playerChrome';
import { SheetActions } from './ui/sheets/itemActions';
import { Shell } from './ui/shell';
import { VIEWS } from './ui/views/registry';

const root = required(document, '#app');
const tokens = new LocalTokenStore();
const http = new HttpClient(tokens);
const store = new Store<AppState>(initialState);

const library = new LibraryService(new HttpLibraryApi(http), store);
const collections = new CollectionsService(new HttpCollectionsApi(http), store);
const playback = new PlaybackService(new HttpPlaybackApi(http), store);
const clock = new PlaybackClock(store);
const bindings = new PlayerBindings();
const covers = new Covers(new HttpArtworkApi(tokens));

// The navigator renders through the shell, which needs the navigator: bound late.
let shell: Shell | null = null;
const nav = new Navigator(store, library, collections, () => shell?.render());
const actions = new SheetActions({ store, collections, nav, playback });

const ctx: AppContext = {
  store,
  nav,
  playback,
  clock,
  collections,
  settings: new HttpSettingsApi(http),
  covers,
  bindings,
  actions,
};
const chromeDeps = { store, covers, nav, playback, clock, bindings };
shell = new Shell(root, ctx, VIEWS, {
  mini: new MiniPlayer(chromeDeps),
  header: new HeaderPlayer(chromeDeps),
  bar: new NowBar(chromeDeps),
});

const app = new App({
  root,
  store,
  tokens,
  auth: new HttpAuthApi(http),
  live: new LiveUpdates(tokens),
  playback,
  clock,
  library,
  collections,
  bindings,
  shell,
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}

void app.start();
