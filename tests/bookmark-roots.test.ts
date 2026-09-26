import { describe, expect, it } from 'vitest';
import { identifyRoots, isSeparator } from '../src/adapters/bookmark-roots';

function folder(
  id: string,
  title: string,
  extra: Partial<chrome.bookmarks.BookmarkTreeNode> = {},
): chrome.bookmarks.BookmarkTreeNode {
  return { id, title, syncing: false, children: [], ...extra };
}

function keysOf(root: chrome.bookmarks.BookmarkTreeNode) {
  return identifyRoots(root).map((entry) => [entry.root, entry.node.id]);
}

describe('identifyRoots', () => {
  it('maps Firefox roots by their fixed ids, menu first', () => {
    const root = folder('root________', '', {
      children: [
        folder('menu________', 'Lesezeichen-Menü'),
        folder('toolbar_____', 'Lesezeichen-Symbolleiste'),
        folder('unfiled_____', 'Weitere Lesezeichen'),
        folder('mobile______', 'Mobile Lesezeichen'),
      ],
    });

    expect(keysOf(root)).toEqual([
      ['menu', 'menu________'],
      ['bar', 'toolbar_____'],
      ['other', 'unfiled_____'],
      ['mobile', 'mobile______'],
    ]);
  });

  it('maps Chromium roots by folderType regardless of order and ignores managed', () => {
    const root = folder('0', '', {
      children: [
        folder('3', 'Mobile', { folderType: 'mobile' }),
        folder('9', 'Managed', { folderType: 'managed' }),
        folder('1', 'Leiste', { folderType: 'bookmarks-bar' }),
        folder('2', 'Weitere', { folderType: 'other' }),
      ],
    });

    expect(keysOf(root)).toEqual([
      ['mobile', '3'],
      ['bar', '1'],
      ['other', '2'],
    ]);
  });

  it('falls back to position for Chromium trees without folderType', () => {
    const root = folder('0', '', {
      children: [
        folder('1', 'Bar'),
        folder('2', 'Other'),
        folder('3', 'Mobile'),
        folder('4', 'Managed'),
      ],
    });

    expect(keysOf(root)).toEqual([
      ['bar', '1'],
      ['other', '2'],
      ['mobile', '3'],
    ]);
  });
});

describe('isSeparator', () => {
  it('recognizes Firefox separators only', () => {
    expect(
      isSeparator({
        id: 's',
        title: '',
        syncing: false,
        url: 'data:',
        type: 'separator',
      } as chrome.bookmarks.BookmarkTreeNode),
    ).toBe(true);
    expect(isSeparator(folder('f', 'Folder'))).toBe(false);
  });
});
