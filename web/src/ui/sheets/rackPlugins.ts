import type { RackApi } from '../../api/rackApi';
import type { RackPlugin, RackSnapshot } from '../../api/types';
import { errorMessage } from '../../core/errors';
import { escapeHtml, required } from '../../core/html';
import { icons } from '../icons';
import { closeOverlay, openPanel, showToast } from '../overlay';


/** Installed stereo effects: the ones shipped with the host first, then by vendor. */
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
        const row = (p: RackPlugin, i: number, title: string, sub: string) => `
          <button type="button" class="ah-row rack-plugin" data-plugin="${i}" ${p.stereo ? '' : 'disabled'}>
            <span class="rack-insert-name">${escapeHtml(title)}</span>
            <span class="rack-insert-sub">${escapeHtml(sub)}</span>
          </button>`;
        // Mono and multichannel variants cannot go in the rack: left out, counted below.
        const indexed = plugins.map((p, i) => ({ p, i })).filter(({ p }) => p.stereo);
        const hidden = plugins.length - indexed.length;
        // What ships with the host first, by its job; then everything else by vendor.
        const included = indexed
          .filter(({ p }) => p.role)
          .map(({ p, i }) => row(p, i, p.role ?? p.name, `${p.vendor} ${p.name}`))
          .join('');
        const vendors = [...new Set(indexed.filter(({ p }) => !p.role).map(({ p }) => p.vendor || 'Other'))];
        const others = vendors
          .map((vendor) => {
            const rows = indexed
              .filter(({ p }) => !p.role && (p.vendor || 'Other') === vendor)
              .map(({ p, i }) =>
                row(
                  p,
                  i,
                  p.name,
                  `${p.format.toUpperCase()}${p.version ? ` · ${p.version}` : ''}`
                )
              )
              .join('');
            return `<p class="ah-section">${escapeHtml(vendor)}</p><div class="ah-group">${rows}</div>`;
          })
          .join('');
        list.innerHTML =
          (included ? `<p class="ah-section">Included with Audio Harbor</p><div class="ah-group">${included}</div>` : '') +
          others +
          (hidden ? `<p class="rack-empty">${hidden} more are not stereo effects and cannot go in the rack.</p>` : '');
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
