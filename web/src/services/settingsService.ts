import type { SettingsApi } from '../api/settingsApi';
import type { SettingsPatch, SettingsSnapshot } from '../api/types';
import type { Store } from '../core/store';
import type { AppState } from '../state/appState';

/** What the settings panes may ask of the host's Settings. */
export interface HostSettings {
  /** A fresh snapshot from the host. */
  refresh(): Promise<void>;
  /** One change; the snapshot after it lands in the store. */
  apply(patch: SettingsPatch): Promise<void>;
}

/** The host's Settings snapshot in the store: from requests, and as the host pushes changes. */
export class SettingsService implements HostSettings {
  constructor(
    private readonly api: SettingsApi,
    private readonly store: Store<AppState>
  ) {}

  async refresh(): Promise<void> {
    this.receive(await this.api.settings());
  }

  /** A snapshot pushed by the host. */
  receive(settings: SettingsSnapshot): void {
    this.store.update({ settings });
  }

  async apply(patch: SettingsPatch): Promise<void> {
    this.receive(await this.api.applySettings(patch));
  }
}
