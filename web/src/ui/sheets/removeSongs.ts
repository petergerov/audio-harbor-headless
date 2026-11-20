import { haptic } from '../../core/device';
import { errorMessage } from '../../core/errors';
import { songs } from '../../core/format';
import type { OpenCollection } from '../../state/appState';
import { showToast } from '../overlay';
import type { SheetDeps } from './sheetDeps';

/** "Remove from Playlist", or "Remove Label “Jazz”" — for one song or every ticked one. */
export function removeTitle(collection: OpenCollection): string {
  return collection.kind === 'playlist' ? 'Remove from Playlist' : `Remove Label “${collection.id}”`;
}

/**
 * Takes the songs out of the open playlist, or the open label off them, as the Mac app 1.1.8 does:
 * no question asked, a notice with Undo puts them back in their places. The files stay where they
 * are. Answers whether anything was taken out.
 */
export async function removeSongs(collection: OpenCollection, paths: string[], deps: SheetDeps): Promise<boolean> {
  if (!paths.length) return false;
  const reload = () => deps.nav.refresh();
  try {
    if (collection.kind === 'playlist') {
      const removal = await deps.collections.removePaths(collection.id, paths);
      if (!removal.removed.length) return false;
      haptic();
      showToast(`Removed ${songs(removal.removed.length)} from “${collection.title}”`, {
        undo: async () => {
          try {
            await deps.collections.restorePaths(collection.id, removal);
          } catch (err) {
            showToast(errorMessage(err, 'Could not put them back'), { error: true });
          }
          await reload();
        },
      });
    } else {
      const removed = await deps.collections.removeLabelFromPaths(collection.id, paths);
      if (!removed.length) return false;
      haptic();
      showToast(`Took the label “${collection.id}” off ${songs(removed.length)}`, {
        undo: async () => {
          try {
            await deps.collections.addLabelToPaths(collection.id, removed);
          } catch (err) {
            showToast(errorMessage(err, 'Could not put it back'), { error: true });
          }
          await reload();
        },
      });
    }
  } catch (err) {
    showToast(errorMessage(err, 'Could not remove them'), { error: true });
    return false;
  }
  await reload();
  return true;
}
