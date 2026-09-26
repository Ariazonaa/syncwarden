import type { BookmarkRoot } from '../core/paths';

// Identifies the editable bookmark roots by fixed markers instead of their
// position: Firefox orders them menu, toolbar, unfiled, mobile, Chromium bar,
// other, mobile. Titles are localized and never used.

export interface RootEntry {
  root: BookmarkRoot;
  node: chrome.bookmarks.BookmarkTreeNode;
}

const FIREFOX_ROOT_IDS: Record<string, BookmarkRoot> = {
  toolbar_____: 'bar',
  unfiled_____: 'other',
  menu________: 'menu',
  mobile______: 'mobile',
};

// Chromium 134+ reports folderType. "managed" (enterprise policy) is read-only
// and never a sync root.
const CHROMIUM_FOLDER_TYPES: Record<string, BookmarkRoot> = {
  'bookmarks-bar': 'bar',
  other: 'other',
  mobile: 'mobile',
};

// Older Chromium without folderType: bar, other, mobile, in this order.
const CHROMIUM_POSITIONAL: BookmarkRoot[] = ['bar', 'other', 'mobile'];

export function identifyRoots(
  root: chrome.bookmarks.BookmarkTreeNode,
): RootEntry[] {
  const children = root.children ?? [];
  if (children.some((child) => Object.hasOwn(FIREFOX_ROOT_IDS, child.id))) {
    return collect(
      children.map((node) => ({ root: FIREFOX_ROOT_IDS[node.id], node })),
    );
  }
  if (children.some((child) => child.folderType !== undefined)) {
    return collect(
      children.map((node) => ({
        root: CHROMIUM_FOLDER_TYPES[node.folderType ?? ''],
        node,
      })),
    );
  }
  return collect(
    CHROMIUM_POSITIONAL.map((key, index) => ({
      root: key,
      node: children[index],
    })),
  );
}

export function isSeparator(node: chrome.bookmarks.BookmarkTreeNode): boolean {
  return (node as { type?: string }).type === 'separator';
}

function collect(
  entries: Array<{
    root: BookmarkRoot | undefined;
    node: chrome.bookmarks.BookmarkTreeNode | undefined;
  }>,
): RootEntry[] {
  const seen = new Set<BookmarkRoot>();
  const result: RootEntry[] = [];
  for (const { root, node } of entries) {
    if (root === undefined || node === undefined || seen.has(root)) {
      continue;
    }
    seen.add(root);
    result.push({ root, node });
  }
  return result;
}
