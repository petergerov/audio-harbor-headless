import type { AppContext } from '../../app/context';
import { required } from '../../core/html';
import type { SettingsPane } from '../../state/appState';
import { AboutPane } from './settings/aboutPane';
import { bindInfoNotes } from './settings/infoNotes';
import { OutputPane } from './settings/outputPane';
import { RackPane } from './settings/rackPane';
import { RecordingPane } from './settings/recordingPane';
import { SharingPane } from './settings/sharingPane';
import { SourcesPane } from './settings/sourcesPane';
import type { View, ViewHost } from './view';

/** A part of Settings: mounts into the settings body, cleans up when left. */
export interface Pane {
  render(root: HTMLElement): Promise<void>;
  dispose?(): void;
}

/** The panes in segment order — a new pane is a new entry. */
const PANES: Record<SettingsPane, { label: string; create(ctx: AppContext): Pane }> = {
  sources: { label: 'Sources', create: (ctx) => new SourcesPane(ctx.settings, ctx.store) },
  output: { label: 'Output', create: (ctx) => new OutputPane(ctx.settings) },
  rack: { label: 'Rack', create: (ctx) => new RackPane(ctx.store, ctx.rack) },
  record: {
    label: 'Record',
    create: (ctx) => new RecordingPane(ctx.recording, ctx.settings, () => void ctx.nav.goTo('recordings')),
  },
  sharing: { label: 'Sharing', create: (ctx) => new SharingPane(ctx.store, ctx.hostSettings) },
  about: { label: 'About', create: (ctx) => new AboutPane(ctx.store, ctx.hostSettings, ctx.settings) },
};

/** How long a pane may take before placeholders show. */
const PLACEHOLDER_AFTER_MS = 120;

const PLACEHOLDER = `
  <div class="skeleton-list settings-skeleton" role="status" aria-label="Loading">
    <p class="group-label"><span class="skeleton-line short"></span></p>
    <div class="group">
      ${'<div class="cell"><span class="skeleton-line"></span></div>'.repeat(3)}
    </div>
  </div>`;

export class SettingsView implements View {
  private pane: Pane | null = null;
  private unbindInfo: (() => void) | null = null;

  constructor(private readonly ctx: AppContext) {}

  async render(root: HTMLElement, host: ViewHost): Promise<void> {
    const current = this.ctx.store.get().settingsPane;
    root.innerHTML = `
      <div class="screen-top">
        <div class="page-header phone-quiet">
          <h1 class="large-title">Settings</h1>
          ${host.headerPlayerSlot()}
        </div>
        <p class="engraved phone-hidden">This Host</p>
        <div class="segmented">
          ${(Object.keys(PANES) as SettingsPane[])
            .map(
              (pane) =>
                `<button type="button" data-pane="${pane}" class="${pane === current ? 'active' : ''}">${PANES[pane].label}</button>`
            )
            .join('')}
        </div>
      </div>
      <div data-settings-body></div>
    `;
    root.querySelectorAll<HTMLElement>('[data-pane]').forEach((button) => {
      button.addEventListener('click', () => this.ctx.nav.setSettingsPane(button.dataset.pane as SettingsPane));
    });
    this.pane = PANES[current].create(this.ctx);
    const body = required(root, '[data-settings-body]');
    // Long explanations sit behind an info button at their section's label.
    this.unbindInfo?.();
    this.unbindInfo = bindInfoNotes(body);
    // A pane still waiting for the host after a moment: placeholders, not an empty screen.
    const placeholders = window.setTimeout(() => {
      if (!body.childElementCount) body.innerHTML = PLACEHOLDER;
    }, PLACEHOLDER_AFTER_MS);
    try {
      await this.pane.render(body);
    } finally {
      window.clearTimeout(placeholders);
    }
  }

  dispose(): void {
    this.unbindInfo?.();
    this.unbindInfo = null;
    this.pane?.dispose?.();
    this.pane = null;
  }
}
