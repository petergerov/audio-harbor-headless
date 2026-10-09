import type { CollectionKind, PlayContext } from '../../api/types';
import { haptic } from '../../core/device';
import { openActionMenu, openConfirmDialog, openNameDialog, showToast } from '../overlay';
import type { SheetDeps } from './sheetDeps';

/** How playlists and labels differ in the menu — the flow itself is the same. */
interface KindText {
  noun: string;
  deleteLabel: string;
  deleteMessage: string;
  play(id: string): PlayContext;
}

const KINDS: Record<CollectionKind, KindText> = {
  playlist: {
    noun: 'Playlist',
    deleteLabel: 'Delete Playlist',
    deleteMessage: 'Songs stay in your library.',
    play: (id) => ({ playlistId: id }),
  },
  label: {
    noun: 'Label',
    deleteLabel: 'Delete Label',
    deleteMessage: 'Removes this label from all songs. Songs stay in your library.',
    play: (id) => ({ label: id }),
  },
};

/** Play, open, rename or delete a playlist or label. */
export function openCollectionMenu(kind: CollectionKind, id: string, name: string, deps: SheetDeps): void {
  const text = KINDS[kind];
  openActionMenu({
    title: name,
    subtitle: text.noun,
    groups: [
      [
        { label: 'Play', run: () => deps.play(text.play(id)) },
        { label: 'Open', run: () => deps.nav.openCollection(kind, id, name) },
      ],
      [
        {
          label: 'Rename…',
          run: () =>
            openNameDialog({
              title: `Rename ${text.noun}`,
              initial: name,
              confirmLabel: 'Save',
              onConfirm: async (next) => {
                await deps.collections.rename(kind, id, next);
                showToast(`${text.noun} renamed`);
                await deps.nav.refresh();
              },
            }),
        },
      ],
      [
        {
          label: `${text.deleteLabel}…`,
          danger: true,
          run: () =>
            openConfirmDialog({
              title: `Delete “${name}”?`,
              message: text.deleteMessage,
              confirmLabel: text.deleteLabel,
              onConfirm: async () => {
                await deps.collections.remove(kind, id);
                showToast(`${text.noun} deleted`);
                await deps.nav.refresh();
              },
            }),
        },
      ],
    ],
  });
}

/** Names a new playlist and opens it. */
export function openNewPlaylist(deps: SheetDeps): void {
  openNameDialog({
    title: 'New Playlist',
    placeholder: 'Name',
    confirmLabel: 'Create',
    onConfirm: async (name) => {
      const created = await deps.collections.createPlaylist(name);
      showToast(`Created “${name}”`);
      haptic();
      await deps.collections.refresh();
      await deps.nav.openCollection('playlist', created.id, created.name);
    },
  });
}
