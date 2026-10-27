import type { RackApi } from '../../api/rackApi';
import type { PluginPreset } from '../../api/types';
import { errorMessage } from '../../core/errors';
import { escapeAttr, escapeHtml, required } from '../../core/html';
import { icons } from '../icons';
import { showToast } from '../overlay';

/** From this many on, the list gets a search field. */
const SEARCH_FROM = 12;

/**
 * A plugin's own presets in its sheet: a row naming the one loaded last, which opens the list in
 * place of the controls — grouped by bank or folder, searchable once there are many. Hidden for
 * a plugin without presets.
 */
export class PluginPresetPicker {
  private presets: PluginPreset[] = [];
  private loaded: string | null = null;
  private query = '';
  private host: HTMLElement | null = null;

  constructor(
    private readonly rack: RackApi,
    private readonly insertId: string,
    /** Loads it (one step to undo); the controls redraw. */
    private readonly load: (preset: PluginPreset) => Promise<void>,
    /** The list is open: the controls step aside. */
    private readonly onOpen: (open: boolean) => void
  ) {}

  static html(): string {
    return `<div class="plugin-presets" data-plugin-presets hidden></div>`;
  }

  async mount(root: HTMLElement): Promise<void> {
    const host = required<HTMLElement>(root, '[data-plugin-presets]');
    this.host = host;
    try {
      this.presets = await this.rack.pluginPresets(this.insertId);
    } catch {
      this.presets = [];
    }
    if (!this.presets.length) return;
    host.hidden = false;
    this.paintRow();
  }

  private paintRow(): void {
    if (!this.host) return;
    this.onOpen(false);
    this.host.innerHTML = `
      <div class="ah-group">
        <button type="button" class="ah-row rack-plugin plugin-preset-row" data-presets-open>
          <span class="rack-insert-name">${escapeHtml(this.loaded ?? 'Presets')}</span>
          <span class="rack-insert-sub">${this.presets.length} from the plugin</span>
          ${icons.chevron}
        </button>
      </div>`;
    this.host.querySelector('[data-presets-open]')?.addEventListener('click', () => this.paintList());
  }

  private paintList(): void {
    if (!this.host) return;
    this.onOpen(true);
    const search =
      this.presets.length >= SEARCH_FROM
        ? `<div class="search-wrap rack-search">${icons.search}
             <input type="search" data-preset-search placeholder="Find a preset" aria-label="Find a preset" value="${escapeAttr(this.query)}" />
           </div>`
        : '';
    this.host.innerHTML = `
      <div class="plugin-preset-head">
        <p class="ah-section">Presets</p>
        <button type="button" class="btn-text" data-presets-close>Done</button>
      </div>
      ${search}
      <div data-preset-list></div>`;
    const list = required<HTMLElement>(this.host, '[data-preset-list]');
    const input = this.host.querySelector<HTMLInputElement>('[data-preset-search]');
    input?.addEventListener('input', () => {
      this.query = input.value;
      this.paintMatches(list);
    });
    this.host.querySelector('[data-presets-close]')?.addEventListener('click', () => this.paintRow());
    this.paintMatches(list);
    input?.focus();
  }

  private paintMatches(list: HTMLElement): void {
    const q = this.query.trim().toLowerCase();
    const shown = this.presets
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => !q || p.name.toLowerCase().includes(q) || (p.group ?? '').toLowerCase().includes(q));
    if (!shown.length) {
      list.innerHTML = `<p class="rack-empty">No preset matches “${escapeHtml(this.query)}”.</p>`;
      return;
    }
    const groups = [...new Set(shown.map(({ p }) => p.group ?? ''))];
    list.innerHTML = groups
      .map((group) => {
        const rows = shown
          .filter(({ p }) => (p.group ?? '') === group)
          .map(
            ({ p, i }) => `
            <button type="button" class="ah-row rack-plugin ${p.name === this.loaded ? 'is-on' : ''}" data-preset-index="${i}">
              <span class="rack-insert-name">${escapeHtml(p.name)}</span>
            </button>`
          )
          .join('');
        return `${group ? `<p class="ah-section">${escapeHtml(group)}</p>` : ''}<div class="ah-group">${rows}</div>`;
      })
      .join('');
    list.querySelectorAll<HTMLButtonElement>('[data-preset-index]').forEach((button) =>
      button.addEventListener('click', () => void this.pick(button))
    );
  }

  private async pick(button: HTMLButtonElement): Promise<void> {
    const preset = this.presets[Number(button.dataset.presetIndex)];
    if (!preset) return;
    button.classList.add('is-busy');
    try {
      await this.load(preset);
      this.loaded = preset.name;
      this.paintRow();
    } catch (err) {
      button.classList.remove('is-busy');
      showToast(errorMessage(err, `Could not load ${preset.name}`), { error: true });
    }
  }
}
