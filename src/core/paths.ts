import type { FolderPath } from './types';

export const BOOKMARK_ROOT_PATHS = {
  bar: 'Bookmarks Bar',
  other: 'Other Bookmarks',
  mobile: 'Mobile Bookmarks',
} as const;

export type BookmarkRoot = keyof typeof BOOKMARK_ROOT_PATHS;

/**
 * Root under which the Linkwarden collection tree is mirrored in the browser.
 * The bookmarks bar is the local mirror.
 */
export const LINKWARDEN_LOCAL_ROOT = BOOKMARK_ROOT_PATHS.bar;

export function joinFolderPath(
  root: BookmarkRoot,
  segments: readonly string[],
): FolderPath {
  return [BOOKMARK_ROOT_PATHS[root], ...segments.map(escapePathSegment)].join(
    '/',
  );
}

/**
 * Remote collection path -> local browser path. The Linkwarden top level
 * (empty path or "Unorganized") maps to the mirror root (bookmarks bar);
 * collections are subfolders below it.
 *   remote ""               <-> local "Bookmarks Bar"
 *   remote "Work/Projects"  <-> local "Bookmarks Bar/Work/Projects"
 */
export function remotePathToLocalPath(remotePath: FolderPath): FolderPath {
  const stripped = normalizeFolderPath(remotePath);
  return stripped.length === 0
    ? LINKWARDEN_LOCAL_ROOT
    : `${LINKWARDEN_LOCAL_ROOT}/${stripped}`;
}

/**
 * Local browser path -> remote collection path. Only paths below the mirror
 * root (bookmarks bar) map into collection space; the root itself becomes the
 * empty path (Unorganized / no collection). Other roots (Other/Mobile
 * Bookmarks) return null, so their local path is used as the collection name
 * as is.
 */
export function localMirrorPathToRemotePath(
  localPath: FolderPath,
): FolderPath | null {
  const normalized = normalizeFolderPath(localPath);
  if (normalized === LINKWARDEN_LOCAL_ROOT) {
    return '';
  }
  const prefix = `${LINKWARDEN_LOCAL_ROOT}/`;
  if (!normalized.startsWith(prefix)) {
    return null;
  }
  return normalizeFolderPath(normalized.slice(prefix.length));
}

export function normalizeFolderPath(path: string): FolderPath {
  return path
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join('/');
}

export function escapePathSegment(segment: string): string {
  return segment.trim().replaceAll('%', '%25').replaceAll('/', '%2F');
}

export function unescapePathSegment(segment: string): string {
  return segment.replaceAll('%2F', '/').replaceAll('%25', '%');
}
