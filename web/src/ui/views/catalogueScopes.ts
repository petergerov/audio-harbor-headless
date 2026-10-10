import type { LibraryScope } from '../../api/types';

/** Catalogue segment control — same roots and search prompts as the iOS remote. */
export const CATALOGUE_SCOPES: ReadonlyArray<{
  scope: LibraryScope;
  label: string;
  search: string;
}> = [
  { scope: 'folders', label: 'Dirs', search: 'Find directories & files' },
  { scope: 'albums', label: 'Albums', search: 'Find album, artist, track' },
  { scope: 'artists', label: 'Artists', search: 'Find artist, album, track' },
  { scope: 'playlists', label: 'Lists', search: 'Find playlist, artist, track' },
];
