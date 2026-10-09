import type { Selection } from '../../api/types';
import { haptic } from '../../core/device';
import { errorMessage } from '../../core/errors';
import { initial } from '../../core/format';
import { escapeAttr, escapeHtml } from '../../core/html';
import { openNameDialog, openPanel, showToast } from '../overlay';
import type { SheetDeps } from './sheetDeps';

/** "Add to Playlist": an existing playlist, or a new one made for the selection. */
export async function openPlaylistPicker(selection: Selection, deps: SheetDeps): Promise<void> {
  await deps.collections.refresh();
  const playlists = deps.store.get().collections.playlists;
  const rows = playlists
    .map(
      (p) => `
      <button type="button" class="picker-row" data-id="${escapeAttr(p.id)}">
        <span class="row-icon playlist">${escapeHtml(initial(p.name, 'P'))}</span>
        <span class="picker-text"><strong>${escapeHtml(p.name)}</strong></span>
        <span class="picker-add">Add</span>
      </button>`
    )
    .join('');

  openPanel({
    title: 'Add to Playlist',
    subtitle: selection.title,
    bodyHtml: `
      <div class="ah-group">
        <button type="button" class="picker-row create" data-new>
          <span class="row-icon create" aria-hidden="true">+</span>
          <span class="picker-text"><strong>New Playlist…</strong><span>Create and add</span></span>
        </button>
      </div>
      ${
        rows
          ? `<p class="ah-section">Playlists</p><div class="ah-group picker-list">${rows}</div>`
          : `<p class="picker-empty">No playlists yet.</p>`
      }
    `,
    bind: (root, close) => {
      root.querySelector('[data-new]')?.addEventListener('click', () => {
        close();
        addToNewPlaylist(selection, deps);
      });
      root.querySelectorAll<HTMLElement>('[data-id]').forEach((row) => {
        row.addEventListener('click', async () => {
          const id = row.dataset.id!;
          const name = playlists.find((p) => p.id === id)?.name ?? 'playlist';
          try {
            await deps.collections.addToPlaylist(id, selection);
            close();
            showToast(`Added to “${name}”`, {
              undo: async () => {
                if (selection.cataloguePath) {
                  await deps.collections.removeFromPlaylist(id, selection.cataloguePath);
                }
              },
            });
            haptic();
            await deps.collections.refresh();
          } catch (err) {
            showToast(errorMessage(err, 'Failed'), { error: true });
          }
        });
      });
    },
  });
}

function addToNewPlaylist(selection: Selection, deps: SheetDeps): void {
  openNameDialog({
    title: 'New Playlist',
    placeholder: 'Name',
    initial: selection.title,
    confirmLabel: 'Create',
    onConfirm: async (name) => {
      const created = await deps.collections.createPlaylist(name);
      await deps.collections.addToPlaylist(created.id, selection);
      showToast(`Added to new playlist “${name}”`);
      haptic();
      await deps.collections.refresh();
    },
  });
}
