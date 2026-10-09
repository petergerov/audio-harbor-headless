import type { Selection } from '../../api/types';
import type { OpenCollection } from '../../state/appState';
import { openActionMenu, showToast, type MenuItem } from '../overlay';
import { openLabelEditor } from './labelEditor';
import { openPlaylistPicker } from './playlistPicker';
import type { SheetDeps } from './sheetDeps';

/** "Play or organize" for a row — inside a playlist or label also "remove from it". */
export function openOrganize(selection: Selection, inCollection: OpenCollection | null, deps: SheetDeps): void {
  const groups: MenuItem[][] = [
    [
      {
        label: 'Play',
        run: () =>
          deps.play({
            cataloguePath: selection.cataloguePath,
            albumId: selection.albumId,
            artist: selection.artist,
            folder: selection.folder,
          }),
      },
    ],
    [
      { label: 'Add to Playlist…', run: () => openPlaylistPicker(selection, deps) },
      { label: 'Labels…', run: () => openLabelEditor(selection, deps) },
    ],
  ];
  const path = selection.cataloguePath;
  if (inCollection && path) groups.push([removeFrom(inCollection, path, deps)]);
  openActionMenu({ title: selection.title, subtitle: 'Play or organize', groups });
}

/** Takes the track out of the open playlist or label, with an undo. */
function removeFrom(collection: OpenCollection, cataloguePath: string, deps: SheetDeps): MenuItem {
  const track: Selection = { cataloguePath, title: '' };
  const reload = () => deps.nav.refresh();
  if (collection.kind === 'playlist') {
    return {
      label: 'Remove from Playlist',
      danger: true,
      run: async () => {
        await deps.collections.removeFromPlaylist(collection.id, cataloguePath);
        showToast('Removed', {
          undo: async () => {
            await deps.collections.addToPlaylist(collection.id, track);
            await reload();
          },
        });
        await reload();
      },
    };
  }
  return {
    label: `Remove Label “${collection.id}”`,
    danger: true,
    run: async () => {
      await deps.collections.removeLabel(collection.id, track);
      showToast('Label removed', {
        undo: async () => {
          await deps.collections.addLabel(collection.id, track);
          await reload();
        },
      });
      await reload();
    },
  };
}
