import type { Selection } from '../../api/types';
import type { OpenCollection } from '../../state/appState';
import { songs } from '../../core/format';
import { openActionMenu, type MenuItem } from '../overlay';
import { openLabelEditor } from './labelEditor';
import { openPlaylistPicker } from './playlistPicker';
import { removeSongs, removeTitle } from './removeSongs';
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

/**
 * Takes the song out of the open playlist or label, with Undo — and with it every other ticked
 * song when this one is ticked too, as the Mac's right-click menu does for a selection.
 */
function removeFrom(collection: OpenCollection, cataloguePath: string, deps: SheetDeps): MenuItem {
  const picks = deps.store.get().picks;
  const ticked = picks.selecting && picks.tracks.some((t) => t.cataloguePath === cataloguePath);
  const paths = ticked ? picks.tracks.map((t) => t.cataloguePath) : [cataloguePath];
  const title = removeTitle(collection);
  return {
    label: paths.length > 1 ? `${title} (${songs(paths.length)})` : title,
    danger: true,
    run: async () => {
      const removed = await removeSongs(collection, paths, deps);
      if (removed && ticked) deps.store.update(() => ({ picks: { selecting: false, tracks: [] } }));
    },
  };
}
