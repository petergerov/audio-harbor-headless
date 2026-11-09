import type { AuthApi } from '../api/authApi';
import { ApiError } from '../api/http';
import type { TokenStore } from '../api/http';
import type { LiveUpdates } from '../api/liveUpdates';
import type { SettingsSnapshot } from '../api/types';
import { errorMessage } from '../core/errors';
import type { Store } from '../core/store';
import type { CollectionsService } from '../services/collectionsService';
import type { LibraryService } from '../services/libraryService';
import type { PlaybackClock } from '../services/playbackClock';
import type { PlaybackService } from '../services/playbackService';
import type { SettingsService } from '../services/settingsService';
import type { AppState } from '../state/appState';
import { currentTrack, durationSecs, playbackError } from '../state/selectors';
import type { PlayerBindings } from '../ui/components/playerBindings';
import { showToast } from '../ui/overlay';
import type { Shell } from '../ui/shell';
import { PairingView } from '../ui/views/pairingView';

/** Which library roots are connected, as one string to compare; null before the first snapshot. */
function connectedRoots(settings: SettingsSnapshot | null | undefined): string | null {
  if (!settings) return null;
  return settings.directories.map((d) => `${d.id}:${d.isConnected !== false}`).join(',');
}

/** How often the start is tried again while the host cannot be reached. */
const START_RETRY_MS = 2000;

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
  settings: SettingsService;
  bindings: PlayerBindings;
  /** Puts the screens back where a reload left them. */
  nav: { restore(): void };
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
    deps.clock.onChange((position) =>
      deps.bindings.paintPosition(position, deps.clock.scrubbing, durationSecs(deps.store.get()))
    );
    window.addEventListener('resize', () => {
      if (this.ready && !deps.shell.fits()) deps.shell.updateChrome();
    });
  }

  /**
   * Starts the app; while the host cannot be reached (offline shell from the cache, host restarting)
   * it waits with the "Connecting…" pill and tries again, instead of asking for a code.
   */
  async start(): Promise<void> {
    try {
      await this.boot();
    } catch (err) {
      if (err instanceof ApiError) throw err; // The host answered: not a reachability problem.
      window.setTimeout(() => void this.start(), START_RETRY_MS);
    }
  }

  private async boot(): Promise<void> {
    const { tokens, live, playback, clock, collections, library, settings, shell } = this.deps;
    if (!tokens.get() && (await this.codeRequired())) {
      this.showPairing();
      return;
    }
    this.deps.nav.restore();
    live.connect((message) => {
      if (message.type === 'nowPlaying') playback.receive(message.payload);
      else if (message.type === 'queue') playback.receiveQueue(message.payload);
      else if (message.type === 'settings') {
        const before = connectedRoots(this.deps.store.get().settings);
        settings.receive(message.payload);
        // A folder, drive or share came or went: grey its music out, or bring it back.
        if (this.ready && before !== null && before !== connectedRoots(message.payload)) this.sourcesChanged();
      }
      else if (message.type === 'rack') this.deps.store.update({ rack: message.payload });
      else if (message.type === 'scan') {
        const finished = Boolean(this.deps.store.get().scan?.scanning) && !message.payload.scanning;
        this.deps.store.update({ scan: message.payload });
        // New tracks show up without a reload.
        if (finished && this.ready) {
          library.invalidate();
          void library.load().catch(() => {});
        }
      }
    }, (connection) => {
      if (this.deps.store.get().connection !== connection) this.deps.store.update({ connection });
    });
    try {
      await playback.refresh();
    } catch (err) {
      // Refused: the code was switched on, or this device's token was revoked.
      if (err instanceof ApiError && err.status === 401) {
        tokens.set(null);
        this.showPairing();
        return;
      }
      throw err;
    }
    clock.start();
    await collections.refresh();
    await Promise.all([
      library.load().catch((err) => showToast(errorMessage(err, 'Could not load the library'), { error: true })),
      // A reload inside a label: its tracks (the screen says when they cannot load).
      this.deps.store.get().collections.open ? collections.loadOpen().catch(() => {}) : null,
      settings.refresh().catch((err) => showToast(errorMessage(err, 'Could not load settings'), { error: true })),
    ]);
    this.ready = true;
    shell.render('forward');
  }

  private sourcesChanged(): void {
    const { library, collections } = this.deps;
    library.invalidate();
    void library.load().catch(() => {});
    if (this.deps.store.get().collections.open) void collections.loadOpen().catch(() => {});
  }

  /**
   * The host wants a code (an older host without the setup route: the pairing screen, as before).
   * Throws when the host cannot be reached, so the start waits for it.
   */
  private async codeRequired(): Promise<boolean> {
    try {
      return (await this.deps.auth.setup()).required;
    } catch (err) {
      if (err instanceof ApiError) return true;
      throw err;
    }
  }

  private showPairing(): void {
    new PairingView(this.deps.auth, this.deps.tokens, () => this.start()).render(this.deps.root);
  }

  /**
   * Player chrome appearing or going → it comes or goes, the screen stays; another track → chrome
   * and the track parts of the screen repaint; otherwise only the live bindings move.
   */
  private playbackChanged(state: AppState, previous: AppState): void {
    this.announceError(state);
    if (!this.ready) return;
    const { shell, bindings, clock } = this.deps;
    if (!shell.fits()) shell.updateChrome();
    if (currentTrack(state)?.id !== currentTrack(previous)?.id) shell.trackChanged();
    bindings.sync(state, clock.position);
  }

  /** Toasts a playback failure once, when it first appears. */
  private announceError(state: AppState): void {
    const error = playbackError(state);
    if (error && error !== this.shownError) showToast(error, { error: true });
    this.shownError = error;
  }
}
