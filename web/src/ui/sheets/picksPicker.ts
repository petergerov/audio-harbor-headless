import type { PlaylistChoice } from '../../api/types';
import { haptic } from '../../core/device';
import { errorMessage } from '../../core/errors';
import { songs } from '../../core/format';
import { escapeAttr, escapeHtml } from '../../core/html';
import type { Picks } from '../../state/picks';
import { icons } from '../icons';
import { openNameDialog, openPanel, showToast } from '../overlay';
import type { SheetDeps } from './sheetDeps';

/**
 * Add to Playlist for the songs ticked in Catalogue: tap a playlist to add them all, or name a
 * new one. A check marks a playlist that already holds every one of them.
 */
export async function openPicksPicker(picks: Picks, deps: SheetDeps): Promise<void> {
  const tracks = picks.state.tracks;
  if (!tracks.length) return;
  const paths = tracks.map((t) => t.cataloguePath);
  let choices: PlaylistChoice[];
  try {
    choices = await deps.collections.playlistChoices(paths);
  } catch (err) {
    showToast(errorMessage(err, 'Could not load the playlists'), { error: true });
    return;
  }
  const those = paths.length === 1 ? 'that song' : 'those songs';
  const done = async (message: string) => {
    picks.end();
    haptic();
    showToast(message);
    await deps.collections.refresh();
  };

  const rows = choices
    .map(
      (p) => `
      <button type="button" class="picker-row" data-id="${escapeAttr(p.id)}">
        <span class="row-icon playlist">${icons.tileList}</span>
        <span class="picker-text"><strong>${escapeHtml(p.name)}</strong></span>
        ${
          p.containsTrack
            ? `<span class="picker-check" aria-label="Holds all of them">✓</span>`
            : `<span class="picker-add">Add</span>`
        }
      </button>`
    )
    .join('');

  openPanel({
    title: 'Add to Playlist',
    subtitle: `${songs(paths.length)} selected`,
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
        openNameDialog({
          title: 'New Playlist',
          placeholder: 'Name',
          confirmLabel: 'Create',
          onConfirm: async (name) => {
            const created = await deps.collections.createPlaylist(name);
            const added = await deps.collections.addPaths(created.id, paths);
            await done(`Added ${songs(added)} to new playlist “${created.name}”`);
          },
        });
      });
      root.querySelectorAll<HTMLElement>('[data-id]').forEach((row) => {
        row.addEventListener('click', async () => {
          const choice = choices.find((p) => p.id === row.dataset.id);
          if (!choice) return;
          try {
            const added = await deps.collections.addPaths(choice.id, paths);
            close();
            await done(
              added === 0
                ? `“${choice.name}” already holds ${those}`
                : `Added ${songs(added)} to “${choice.name}”`
            );
          } catch (err) {
            showToast(errorMessage(err, 'Failed'), { error: true });
          }
        });
      });
    },
  });
}
