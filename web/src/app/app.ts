import type { AuthApi } from '../api/authApi';
import type { TokenStore } from '../api/http';
import type { LiveUpdates } from '../api/liveUpdates';
import { errorMessage } from '../core/errors';
import type { Store } from '../core/store';
import type { CollectionsService } from '../services/collectionsService';
import type { LibraryService } from '../services/libraryService';
import type { PlaybackClock } from '../services/playbackClock';
import type { PlaybackService } from '../services/playbackService';
import type { AppState } from '../state/appState';
import { currentTrack, playbackError } from '../state/selectors';
import type { PlayerBindings } from '../ui/components/playerBindings';
import { showToast } from '../ui/overlay';
import type { Shell } from '../ui/shell';
import { PairingView } from '../ui/views/pairingView';

export interface AppDeps {
  root: HTMLElement;
  store: Store<AppState>;
  tokens: TokenStore;
  auth: AuthApi;
  live: LiveUpdates;
  playback: PlaybackService;
  clock: PlaybackClock;
  library: LibraryService;
  collections: CollectionsService;
  bindings: PlayerBindings;
  shell: Shell;
}

/** Starts the app (pairing first when needed) and keeps the screen in step with playback. */
export class App {
  private ready = false;
  private shownError = '';

  constructor(private readonly deps: AppDeps) {
    deps.store.subscribe((state, previous) => {
      if (state.nowPlaying !== previous.nowPlaying) this.playbackChanged(state, previous);
    });
    deps.clock.onChange((position) => deps.bindings.paintPosition(position, deps.clock.scrubbing));
    window.addEventListener('resize', () => {
      if (this.ready && !deps.shell.fits()) deps.shell.render();
    });
  }

  async start(): Promise<void> {
    const { tokens, live, playback, clock, collections, library, shell } = this.deps;
    if (!tokens.get()) {
      this.showPairing();
      return;
    }
    live.connect((message) => {
      if (message.type === 'nowPlaying') playback.receive(message.payload);
    });
    try {
      await playback.refresh();
    } catch {
      // The token is no longer valid on this host.
      tokens.set(null);
      this.showPairing();
      return;
    }
    clock.start();
    await collections.refresh();
    await library.load().catch((err) => showToast(errorMessage(err, 'Could not load the library'), { error: true }));
    this.ready = true;
    shell.render();
  }

  private showPairing(): void {
    new PairingView(this.deps.auth, this.deps.tokens, () => this.start()).render(this.deps.root);
  }

  /**
   * Player chrome appearing or going → new layout; another track → chrome and the track parts
   * of the screen repaint; otherwise only the live bindings move.
   */
  private playbackChanged(state: AppState, previous: AppState): void {
    this.announceError(state);
    if (!this.ready) return;
    const { shell, bindings } = this.deps;
    if (!shell.fits()) {
      shell.render();
      return;
    }
    if (currentTrack(state)?.id !== currentTrack(previous)?.id) shell.trackChanged();
    bindings.sync(state);
  }

  /** Toasts a playback failure once, when it first appears. */
  private announceError(state: AppState): void {
    const error = playbackError(state);
    if (error && error !== this.shownError) showToast(error, { error: true });
    this.shownError = error;
  }
}
