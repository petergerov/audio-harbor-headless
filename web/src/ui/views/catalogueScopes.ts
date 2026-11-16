import type { LibraryScope } from '../../api/types';

/** Catalogue segment control — same roots and search prompts as the iOS remote. */
export const CATALOGUE_SCOPES: ReadonlyArray<{
  scope: LibraryScope;
  label: string;
  /** The Mac catalogue's wording (desktop). */
  long: string;
  search: string;
}> = [
  { scope: 'folders', label: 'Dirs', long: 'Directories', search: 'Find directories & files' },
  { scope: 'albums', label: 'Albums', long: 'Albums', search: 'Find album, artist, track' },
  { scope: 'artists', label: 'Artists', long: 'Artists', search: 'Find artist, album, track' },
  { scope: 'playlists', label: 'Lists', long: 'Playlists', search: 'Find playlist, artist, track' },
];
