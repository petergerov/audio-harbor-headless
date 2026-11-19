import type { Store } from '../core/store';
import type { AppState, PickedTrack, PicksState } from './appState';

/** Catalogue's Select mode: the ticked songs, kept across levels, scopes and searches. */
export class Picks {
  constructor(private readonly store: Store<AppState>) {}

  get state(): PicksState {
    return this.store.get().picks;
  }

  has(path: string): boolean {
    return this.state.tracks.some((t) => t.cataloguePath === path);
  }

  start(): void {
    this.patch({ selecting: true });
  }

  /** Done: Select mode ends and the ticks go. */
  end(): void {
    this.patch({ selecting: false, tracks: [] });
  }

  toggle(track: PickedTrack): void {
    const tracks = this.has(track.cataloguePath)
      ? this.state.tracks.filter((t) => t.cataloguePath !== track.cataloguePath)
      : [...this.state.tracks, track];
    this.patch({ selecting: true, tracks });
  }

  /** Ticks every one of `more` not ticked yet, in their order. */
  select(more: PickedTrack[]): void {
    const known = new Set(this.state.tracks.map((t) => t.cataloguePath));
    const added = more.filter((t) => !known.has(t.cataloguePath) && known.add(t.cataloguePath));
    this.patch({ selecting: true, tracks: [...this.state.tracks, ...added] });
  }

  clear(): void {
    this.patch({ tracks: [] });
  }

  private patch(change: Partial<PicksState>): void {
    this.store.update((state) => ({ picks: { ...state.picks, ...change } }));
  }
}
