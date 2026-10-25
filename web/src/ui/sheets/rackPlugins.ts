import type { RackApi } from '../../api/rackApi';
import type { RackPlugin, RackSnapshot } from '../../api/types';
import { errorMessage } from '../../core/errors';
import { escapeHtml, required } from '../../core/html';
import { icons } from '../icons';
import { closeOverlay, openPanel, showToast } from '../overlay';


const FORMAT_LABEL: Record<string, string> = { clap: 'CLAP', vst3: 'VST3', au: 'AU', lv2: 'LV2' };
/** Which format of a plugin the rack takes when it is installed in several. */
const FORMAT_RANK: Record<string, number> = { clap: 0, vst3: 1, au: 2, lv2: 3 };

/**
 * One entry per plugin (vendor and name): the best-ranked format, and for it the other formats
 * the same plugin is installed in ("AU, VST3").
 */
function preferredFormats(entries: Array<{ p: RackPlugin; i: number }>) {
  const byPlugin = new Map<string, Array<{ p: RackPlugin; i: number }>>();
  for (const e of entries) {
    const key = `${e.p.vendor.toLowerCase()}|${e.p.name.toLowerCase()}`;
    byPlugin.set(key, [...(byPlugin.get(key) ?? []), e]);
  }
  const indexed: Array<{ p: RackPlugin; i: number }> = [];
  const others = new Map<number, string>();
  for (const group of byPlugin.values()) {
    group.sort((a, b) => (FORMAT_RANK[a.p.format] ?? 9) - (FORMAT_RANK[b.p.format] ?? 9));
    const [best, ...rest] = group;
    if (!best) continue;
    indexed.push(best);
    if (rest.length) others.set(best.i, rest.map((e) => FORMAT_LABEL[e.p.format] ?? e.p.format).join(', '));
  }
  // The host's order (shipped first, then by vendor and name) stays.
  indexed.sort((a, b) => a.i - b.i);
  return { indexed, others };
}

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
          list.innerHTML = `<p class="rack-empty">No plugins found. Install CLAP, VST3 or AU (Mac) or LV2 (Linux) plugins on the host, then look again.</p>`;
          return;
        }
        const row = (p: RackPlugin, i: number, title: string, sub: string) => `
          <button type="button" class="ah-row rack-plugin" data-plugin="${i}" ${p.stereo ? '' : 'disabled'}>
            <span class="rack-insert-name">${escapeHtml(title)}</span>
            <span class="rack-insert-sub">${escapeHtml(sub)}</span>
          </button>`;
        // Mono and multichannel variants cannot go in the rack: left out, counted below. A
        // plugin installed in several formats is listed once, in the one the rack runs best.
        const stereo = plugins.map((p, i) => ({ p, i })).filter(({ p }) => p.stereo);
        const hidden = plugins.length - stereo.length;
        const { indexed, others: alsoIn } = preferredFormats(stereo);
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
              .map(({ p, i }) => {
                const also = alsoIn.get(i);
                return row(
                  p,
                  i,
                  p.name,
                  `${FORMAT_LABEL[p.format] ?? p.format}${p.version ? ` · ${p.version}` : ''}${also ? ` · also ${also}` : ''}`
                );
              })
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
        list.innerHTML = `<p class="rack-empty">${rescan ? 'Looking again…' : 'Looking for plugins…'} The first look at a host with many plugins takes a few minutes; after that only new ones are checked.</p>`;
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
