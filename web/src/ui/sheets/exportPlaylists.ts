import type { SettingsApi } from '../../api/settingsApi';
import { openActionMenu, showToast } from '../overlay';
import { openFolderPicker } from './folderPicker';
import type { SheetDeps } from './sheetDeps';

/**
 * Export All: every playlist as `<name>.m3u8` into a folder on the host, as the Mac does it.
 * The files hold the host's own paths, so players on the host (or reading the same drive at the
 * same place) open them; files of the same name are replaced.
 */
export function openExportPlaylists(settings: SettingsApi, deps: SheetDeps): void {
  openFolderPicker({
    api: settings,
    confirmLabel: 'Export',
    onPick: async (folder) => {
      const result = await deps.collections.exportPlaylists(folder);
      const where = folder.split(/[/\\]/).filter(Boolean).pop() ?? folder;
      const lines = [
        result.written === 1
          ? `1 playlist saved as M3U8 in “${where}”.`
          : `${result.written} playlists saved as M3U8 files in “${where}”.`,
      ];
      if (result.empty.length) lines.push(`Left out, no songs: ${result.empty.join(', ')}.`);
      if (result.failed.length) lines.push(`Could not be written: ${result.failed.join('; ')}.`);
      if (!result.empty.length && !result.failed.length) {
        showToast(lines[0]!);
        return;
      }
      // Once the picker has closed (it does after this returns), the report takes its place.
      window.setTimeout(() =>
        openActionMenu({
          title: result.failed.length ? 'Some Playlists Not Exported' : 'Playlists Exported',
          subtitle: lines.join(' '),
          wrapSubtitle: true,
          groups: [[{ label: 'OK', run: () => undefined }]],
        })
      );
    },
  });
}
