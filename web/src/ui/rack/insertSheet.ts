import type { RackApi } from '../../api/rackApi';
import type { RackInsert, RackSnapshot } from '../../api/types';
import { errorMessage } from '../../core/errors';
import { escapeHtml, required } from '../../core/html';
import { openPanel, showToast } from '../overlay';
import type { InsertView } from './insertView';
import { PANELS } from './panels/specs';
import { PanelView } from './panels/panelView';
import { ParamListView } from './paramList';
import { PluginPresetPicker } from './pluginPresets';
import { SettingsHistory } from './settingsHistory';

type Mode = 'panel' | 'all';

/**
 * An insert's sheet: its own panel when the remote knows the plugin, every parameter a tap
 * away, and above both: compare with how it was when opened, undo, reset to defaults, the
 * plugin's own presets, and its own editor on the host's screen.
 */
export function openInsertSheet(rack: RackApi, insert: RackInsert, onRack: (snapshot: RackSnapshot) => void): void {
  const spec = PANELS[insert.pluginId];
  let mode: Mode = spec ? 'panel' : 'all';
  let view: InsertView | null = null;

  openPanel({
    title: insert.name,
    subtitle: insert.vendor,
    bodyHtml: `
      <div class="rack-sheet">
        <div class="insert-tools">
          <div class="segmented compact" data-modes ${spec ? '' : 'hidden'}>
            <button type="button" data-mode="panel">Panel</button>
            <button type="button" data-mode="all">All</button>
          </div>
          <span class="insert-tools-gap"></span>
          <button type="button" class="deck-pill" data-compare aria-pressed="false" title="Before / now">A/B</button>
          <button type="button" class="deck-pill" data-undo disabled>Undo</button>
          <button type="button" class="deck-pill" data-reset>Reset</button>
        </div>
        ${PluginPresetPicker.html()}
        <div class="ah-group host-editor" ${insert.editor ? '' : 'hidden'}>
          <button type="button" class="ah-row rack-plugin" data-host-editor></button>
        </div>
        <div data-insert-view></div>
      </div>`,
    bind: (root) => {
      const container = required(root, '[data-insert-view]');
      const compare = required<HTMLButtonElement>(root, '[data-compare]');
      const undo = required<HTMLButtonElement>(root, '[data-undo]');
      const history = new SettingsHistory(
        rack,
        insert.id,
        () => void view?.reload(),
        () => {
          undo.disabled = !history.canUndo;
          compare.classList.toggle('is-on', history.isComparing);
          compare.setAttribute('aria-pressed', String(history.isComparing));
        }
      );
      const show = async (next: Mode) => {
        mode = next;
        root.querySelectorAll<HTMLElement>('[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
        view =
          mode === 'panel' && spec
            ? new PanelView(rack, insert.id, spec, () => history.changed())
            : new ParamListView(rack, insert.id, insert.pinned.map((p) => p.id), onRack, () => history.changed());
        try {
          await view.mount(container);
        } catch (err) {
          container.innerHTML = `<p class="rack-empty">${escapeHtml(errorMessage(err, 'The plugin did not answer'))}</p>`;
        }
      };
      const guarded = (run: () => Promise<void>, failure: string) => async () => {
        try {
          await run();
        } catch (err) {
          showToast(errorMessage(err, failure), { error: true });
        }
      };
      root.querySelectorAll<HTMLElement>('[data-mode]').forEach((b) =>
        b.addEventListener('click', () => void show(b.dataset.mode as Mode))
      );
      compare.addEventListener('click', guarded(() => history.toggleCompare(), 'Could not compare'));
      undo.addEventListener('click', guarded(() => history.undo(), 'Could not undo'));
      root.querySelector('[data-reset]')?.addEventListener(
        'click',
        guarded(() => history.reset(), 'Could not reset the plugin')
      );
      void history.start().then((ok) => {
        compare.disabled = !ok;
        undo.disabled = true;
      });
      const presets = new PluginPresetPicker(
        rack,
        insert.id,
        (preset) => history.loadPreset(preset.id),
        (open) => {
          container.hidden = open;
        }
      );
      void presets.mount(root);
      bindHostEditor(root, rack, insert, onRack, () => void view?.reload());
      void show(mode);
    },
  });
}

/**
 * The plugin's own editor in a window on the host's screen (a Mac at the hi-fi, say). Knobs
 * turned there come back to the remote within a moment; closing it here closes the window.
 */
function bindHostEditor(
  root: HTMLElement,
  rack: RackApi,
  insert: RackInsert,
  onRack: (snapshot: RackSnapshot) => void,
  onClosed: () => void
): void {
  const row = root.querySelector<HTMLButtonElement>('[data-host-editor]');
  if (!row) return;
  let open = insert.editorOpen;
  const paint = () => {
    row.innerHTML = `
      <span class="rack-insert-name">${open ? 'Close the Plugin Window' : 'Open the Plugin Window'}</span>
      <span class="rack-insert-sub">${open ? 'Open on the host’s screen' : 'The plugin’s own editor, on the host’s screen'}</span>`;
  };
  paint();
  row.addEventListener('click', async () => {
    row.classList.add('is-busy');
    try {
      const snapshot = open ? await rack.closeEditor(insert.id) : await rack.openEditor(insert.id);
      open = snapshot.inserts.find((i) => i.id === insert.id)?.editorOpen ?? false;
      paint();
      onRack(snapshot);
      if (!open) onClosed();
    } catch (err) {
      showToast(errorMessage(err, 'The plugin window did not open'), { error: true });
    } finally {
      row.classList.remove('is-busy');
    }
  });
}
