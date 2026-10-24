import type { RackApi } from '../../api/rackApi';
import type { RackParam, RackPlugin, RackSnapshot } from '../../api/types';
import { errorMessage } from '../../core/errors';
import { escapeHtml, required } from '../../core/html';
import { icons } from '../icons';
import { bindParamSliders, paramSliderHtml } from '../components/rackControls';
import { closeOverlay, openPanel, showToast } from '../overlay';

const MAX_PINNED = 6;

/** Installed plugins by vendor; only stereo effects can be chosen. */
export function openPluginPicker(rack: RackApi, onAdded: (snapshot: RackSnapshot) => void): void {
  let plugins: RackPlugin[] = [];
  let busy = false;
  openPanel({
    title: 'Add Plugin',
    subtitle: 'Installed on this host',
    bodyHtml: `
      <div data-plugin-list><p class="rack-empty">Looking for plugins…</p></div>
      <button type="button" class="ah-row rack-edit" data-rescan>${icons.rescan} Look Again</button>
    `,
    bind: (root) => {
      const list = required(root, '[data-plugin-list]');
      const paint = () => {
        if (!plugins.length) {
          list.innerHTML = `<p class="rack-empty">No plugins found. Install CLAP plugins (or LV2 on Linux) on the host, then look again.</p>`;
          return;
        }
        const vendors = [...new Set(plugins.map((p) => p.vendor || 'Other'))];
        list.innerHTML = vendors
          .map((vendor) => {
            const rows = plugins
              .map((p, i) => ({ p, i }))
              .filter(({ p }) => (p.vendor || 'Other') === vendor)
              .map(
                ({ p, i }) => `
                <button type="button" class="ah-row rack-plugin" data-plugin="${i}" ${p.stereo ? '' : 'disabled'}>
                  <span class="rack-insert-name">${escapeHtml(p.name)}</span>
                  <span class="rack-insert-sub">${escapeHtml(
                    `${p.format.toUpperCase()}${p.version ? ` · ${p.version}` : ''}${p.stereo ? '' : ' · not a stereo effect'}`
                  )}</span>
                </button>`
              )
              .join('');
            return `<p class="ah-section">${escapeHtml(vendor)}</p><div class="ah-group">${rows}</div>`;
          })
          .join('');
        list.querySelectorAll<HTMLButtonElement>('[data-plugin]').forEach((button) => {
          button.addEventListener('click', async () => {
            const plugin = plugins[Number(button.dataset.plugin)];
            if (!plugin || busy) return;
            busy = true;
            button.classList.add('is-busy');
            try {
              const snapshot = await rack.add(plugin);
              closeOverlay();
              onAdded(snapshot);
              const added = snapshot.inserts[snapshot.inserts.length - 1];
              showToast(added?.error ? `${plugin.name}: ${added.error}` : `${plugin.name} added`, {
                error: Boolean(added?.error),
              });
            } catch (err) {
              showToast(errorMessage(err, `Could not add ${plugin.name}`), { error: true });
            } finally {
              busy = false;
              button.classList.remove('is-busy');
            }
          });
        });
      };
      const load = async (rescan: boolean) => {
        list.innerHTML = `<p class="rack-empty">${rescan ? 'Looking again…' : 'Looking for plugins…'}</p>`;
        try {
          plugins = await rack.plugins(rescan);
          paint();
        } catch (err) {
          list.innerHTML = `<p class="rack-empty">${escapeHtml(errorMessage(err, 'Could not list the plugins'))}</p>`;
        }
      };
      root.querySelector('[data-rescan]')?.addEventListener('click', () => void load(true));
      void load(false);
    },
  });
}

/**
 * Every parameter of one insert, as sliders with the plugin's own value text; the star pins
 * up to six to the rack sheet. A search narrows plugins with hundreds of parameters.
 */
export function openParamSheet(
  rack: RackApi,
  insert: { id: string; name: string },
  pinned: string[],
  onPinned: (snapshot: RackSnapshot) => void
): void {
  let params: RackParam[] = [];
  let pins = [...pinned];
  openPanel({
    title: insert.name,
    subtitle: 'Parameters',
    bodyHtml: `
      <div class="rack-sheet">
        <div class="search-wrap rack-search">${icons.search}
          <input type="search" data-param-search placeholder="Find a parameter" aria-label="Find a parameter" />
        </div>
        <p class="rack-pin-note" data-pin-note></p>
        <div data-param-list><p class="rack-empty">Asking the plugin…</p></div>
      </div>
    `,
    bind: (root) => {
      const list = required(root, '[data-param-list]');
      const search = required<HTMLInputElement>(root, '[data-param-search]');
      const note = required(root, '[data-pin-note]');
      const paint = () => {
        note.textContent = `${pins.length} of ${MAX_PINNED} pinned to the rack sheet`;
        const q = search.value.trim().toLowerCase();
        const shown = params.filter(
          (p) => !p.isBypass && (!q || p.name.toLowerCase().includes(q) || (p.module ?? '').toLowerCase().includes(q))
        );
        if (!shown.length) {
          list.innerHTML = `<p class="rack-empty">${params.length ? 'No parameter matches.' : 'This plugin shows no parameters.'}</p>`;
          return;
        }
        let module: string | undefined;
        list.innerHTML = shown
          .map((p) => {
            const head =
              p.module && p.module !== module ? `<p class="group-label rack-module">${escapeHtml(p.module)}</p>` : '';
            module = p.module;
            return head + paramSliderHtml(insert.id, p, { pin: true, pinned: pins.includes(p.id) });
          })
          .join('');
        bindParamSliders(list, rack);
        list.querySelectorAll<HTMLButtonElement>('[data-pin]').forEach((button) => {
          button.addEventListener('click', async () => {
            const id = button.dataset.pin ?? '';
            const next = pins.includes(id) ? pins.filter((p) => p !== id) : [...pins, id];
            if (next.length > MAX_PINNED) {
              showToast(`Up to ${MAX_PINNED} knobs on the rack sheet — unpin one first`);
              return;
            }
            try {
              onPinned(await rack.setPinned(insert.id, next));
              pins = next;
              button.classList.toggle('is-on', pins.includes(id));
              button.setAttribute('aria-pressed', String(pins.includes(id)));
              note.textContent = `${pins.length} of ${MAX_PINNED} pinned to the rack sheet`;
            } catch (err) {
              showToast(errorMessage(err, 'Could not pin it'), { error: true });
            }
          });
        });
      };
      search.addEventListener('input', paint);
      void rack
        .params(insert.id)
        .then((p) => {
          params = p;
          paint();
        })
        .catch((err) => {
          list.innerHTML = `<p class="rack-empty">${escapeHtml(errorMessage(err, 'The plugin did not answer'))}</p>`;
        });
    },
  });
}

