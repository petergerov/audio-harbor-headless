import type { AppContext } from '../../app/context';
import { required } from '../../core/html';
import type { SettingsPane } from '../../state/appState';
import { AboutPane } from './settings/aboutPane';
import { OutputPane } from './settings/outputPane';
import { SharingPane } from './settings/sharingPane';
import { SourcesPane } from './settings/sourcesPane';
import type { View } from './view';

/** A part of Settings: mounts into the settings body, cleans up when left. */
export interface Pane {
  render(root: HTMLElement): Promise<void>;
  dispose?(): void;
}

/** The panes in segment order — a new pane is a new entry. */
const PANES: Record<SettingsPane, { label: string; create(ctx: AppContext): Pane }> = {
  sources: { label: 'Sources', create: (ctx) => new SourcesPane(ctx.settings, ctx.store) },
  output: { label: 'Output', create: (ctx) => new OutputPane(ctx.settings) },
  sharing: { label: 'Sharing', create: (ctx) => new SharingPane(ctx.store, ctx.hostSettings) },
  about: { label: 'About', create: (ctx) => new AboutPane(ctx.store, ctx.hostSettings) },
};

export class SettingsView implements View {
  private pane: Pane | null = null;

  constructor(private readonly ctx: AppContext) {}

  async render(root: HTMLElement): Promise<void> {
    const current = this.ctx.store.get().settingsPane;
    root.innerHTML = `
      <h1 class="large-title">Settings</h1>
      <div class="segmented">
        ${(Object.keys(PANES) as SettingsPane[])
          .map(
            (pane) =>
              `<button type="button" data-pane="${pane}" class="${pane === current ? 'active' : ''}">${PANES[pane].label}</button>`
          )
          .join('')}
      </div>
      <div data-settings-body></div>
    `;
    root.querySelectorAll<HTMLElement>('[data-pane]').forEach((button) => {
      button.addEventListener('click', () => this.ctx.nav.setSettingsPane(button.dataset.pane as SettingsPane));
    });
    this.pane = PANES[current].create(this.ctx);
    await this.pane.render(required(root, '[data-settings-body]'));
  }

  dispose(): void {
    this.pane?.dispose?.();
    this.pane = null;
  }
}
