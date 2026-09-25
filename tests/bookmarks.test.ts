import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ChromeBookmarksAdapter,
  isBookmarkWriteGuardActive,
  withBookmarkWriteMutex,
  type BookmarkApi,
} from '../src/adapters/bookmarks';

function node(
  id: string,
  title: string,
  children?: chrome.bookmarks.BookmarkTreeNode[],
  url?: string,
): chrome.bookmarks.BookmarkTreeNode {
  return {
    id,
    title,
    syncing: false,
    ...(children === undefined ? {} : { children }),
    ...(url === undefined ? {} : { url }),
  };
}

function tree(): chrome.bookmarks.BookmarkTreeNode[] {
  return [
    node('root', '', [
      node('bar-id', 'Lesezeichenleiste', [
        node('folder-dev', 'Dev', [
          node('bookmark-1', 'Example', undefined, 'HTTPS://EXAMPLE.COM/#top'),
          node('bookmark-skip', 'Settings', undefined, 'chrome://settings'),
        ]),
      ]),
      node('other-id', 'Other bookmarks', [
        node('bookmark-2', 'Other', undefined, 'https://other.example/'),
      ]),
      node('mobile-id', 'Mobile bookmarks', []),
    ]),
  ];
}

function fakeApi(initialTree = tree()): BookmarkApi {
  let nextId = 100;
  const find = (id: string): chrome.bookmarks.BookmarkTreeNode | undefined => {
    const visit = (
      entries: chrome.bookmarks.BookmarkTreeNode[],
    ): chrome.bookmarks.BookmarkTreeNode | undefined => {
      for (const entry of entries) {
        if (entry.id === id) return entry;
        const nested = visit(entry.children ?? []);
        if (nested !== undefined) return nested;
      }
      return undefined;
    };
    return visit(initialTree);
  };
  return {
    getTree: vi.fn(async () => initialTree),
    create: vi.fn(async (details) => {
      const created = node(
        String(nextId++),
        details.title ?? '',
        details.url === undefined ? [] : undefined,
        details.url,
      );
      created.parentId = details.parentId;
      find(details.parentId ?? '')?.children?.push(created);
      return created;
    }),
    update: vi.fn(async (id, changes) => {
      const target = find(id);
      if (target === undefined) throw new Error('missing');
      if (changes.title !== undefined) target.title = changes.title;
      if (changes.url !== undefined) target.url = changes.url;
      return target;
    }),
    move: vi.fn(async (id, destination) => {
      const target = find(id);
      if (target === undefined) throw new Error('missing');
      target.parentId = destination.parentId;
      return target;
    }),
    remove: vi.fn(async () => undefined),
    removeTree: vi.fn(async () => undefined),
  };
}

describe('ChromeBookmarksAdapter', () => {
  it('maps localized Chromium roots to stable logical prefixes', async () => {
    const inventory = await new ChromeBookmarksAdapter(fakeApi()).readInventory();
    expect(inventory.items).toMatchObject([
      // Below the bookmarks bar (mirror root) -> directly in Linkwarden's
      // top level.
      { chromeId: 'bookmark-1', folderPath: 'Dev' },
      // Other roots keep their local path.
      { chromeId: 'bookmark-2', folderPath: 'Other Bookmarks' },
    ]);
  });

  it('skips unsupported schemes without removing them', async () => {
    const inventory = await new ChromeBookmarksAdapter(fakeApi()).readInventory();
    expect(inventory.skipped).toMatchObject([
      { chromeId: 'bookmark-skip', title: 'Settings' },
    ]);
  });

  it('does not include the Chrome ID in the stable key', async () => {
    const first = await new ChromeBookmarksAdapter(fakeApi()).readInventory();
    const changedTree = tree();
    const bookmark = changedTree[0]?.children?.[0]?.children?.[0]?.children?.[0];
    if (bookmark !== undefined) bookmark.id = 'completely-new-id';
    const second = await new ChromeBookmarksAdapter(
      fakeApi(changedTree),
    ).readInventory();
    expect(first.items[0]?.stableKey).toBe(second.items[0]?.stableKey);
  });

  it('creates missing folders by decoded path segments', async () => {
    const api = fakeApi();
    const adapter = new ChromeBookmarksAdapter(api);
    await adapter.createBookmark({
      url: 'https://created.example',
      title: 'Created',
      folderPath: 'Bookmarks Bar/A%2FB',
    });
    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({ parentId: 'bar-id', title: 'A/B' }),
    );
    expect(api.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: 'Created', url: 'https://created.example' }),
    );
  });

  it('deletes the explicitly planned Chrome ID', async () => {
    const api = fakeApi();
    const adapter = new ChromeBookmarksAdapter(api);
    const inventory = await adapter.readInventory();
    await adapter.deleteBookmark(
      'bookmark-1',
      inventory.items[0]?.stableKey ?? '',
    );
    expect(api.remove).toHaveBeenCalledWith('bookmark-1');
  });

  it('updates the planned bookmark when duplicate URLs share a stable key', async () => {
    const duplicateTree = tree();
    const devFolder = duplicateTree[0]?.children?.[0]?.children?.[0];
    devFolder?.children?.push(
      node(
        'bookmark-duplicate',
        'Duplicate',
        undefined,
        'https://example.com/?utm_source=test#other',
      ),
    );
    const api = fakeApi(duplicateTree);
    const adapter = new ChromeBookmarksAdapter(api);
    const inventory = await adapter.readInventory();
    const duplicate = inventory.items.find(
      (item) => item.chromeId === 'bookmark-duplicate',
    );

    await adapter.updateBookmark(
      'bookmark-duplicate',
      duplicate?.stableKey ?? '',
      {
        url: 'https://example.com/',
        title: 'Updated duplicate',
        folderPath: 'Bookmarks Bar/Dev',
      },
    );

    expect(api.update).toHaveBeenCalledWith('bookmark-duplicate', {
      title: 'Updated duplicate',
      url: 'https://example.com/',
    });
    expect(api.update).not.toHaveBeenCalledWith(
      'bookmark-1',
      expect.anything(),
    );
  });

  it('deletes the planned bookmark when duplicate URLs share a stable key', async () => {
    const duplicateTree = tree();
    const devFolder = duplicateTree[0]?.children?.[0]?.children?.[0];
    devFolder?.children?.push(
      node(
        'bookmark-duplicate',
        'Duplicate',
        undefined,
        'https://example.com/?utm_source=test#other',
      ),
    );
    const api = fakeApi(duplicateTree);
    const adapter = new ChromeBookmarksAdapter(api);
    const inventory = await adapter.readInventory();
    const duplicate = inventory.items.find(
      (item) => item.chromeId === 'bookmark-duplicate',
    );

    await adapter.deleteBookmark(
      'bookmark-duplicate',
      duplicate?.stableKey ?? '',
    );

    expect(api.remove).toHaveBeenCalledTimes(1);
    expect(api.remove).toHaveBeenCalledWith('bookmark-duplicate');
  });

  it('does not fall back to a duplicate when the planned Chrome ID is gone', async () => {
    const api = fakeApi();
    const adapter = new ChromeBookmarksAdapter(api);
    const inventory = await adapter.readInventory();

    await adapter.deleteBookmark(
      'already-removed-id',
      inventory.items[0]?.stableKey ?? '',
    );

    expect(api.remove).not.toHaveBeenCalled();
  });

  it('rejects a planned Chrome ID whose stable key has changed', async () => {
    const api = fakeApi();
    const adapter = new ChromeBookmarksAdapter(api);
    const inventory = await adapter.readInventory();

    await expect(
      adapter.deleteBookmark(
        'bookmark-2',
        inventory.items[0]?.stableKey ?? '',
      ),
    ).rejects.toThrow('changed since the plan was made');
    expect(api.remove).not.toHaveBeenCalled();
  });
});

describe('bookmark write guard', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is active during a guarded write and lingers briefly afterwards', async () => {
    vi.useFakeTimers();
    const values: Record<string, unknown> = {};
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: values[key] }),
          set: async (next: Record<string, unknown>) => Object.assign(values, next),
          remove: async (key: string) => delete values[key],
        },
      },
    });
    try {
      let observed = false;
      await withBookmarkWriteMutex(async () => {
        observed = await isBookmarkWriteGuardActive();
      });
      // The guard was active during the write ...
      expect(observed).toBe(true);
      // ... and lingers briefly (swallowing late Chrome events).
      await expect(isBookmarkWriteGuardActive()).resolves.toBe(true);
      // After the linger window it is inactive again.
      await vi.advanceTimersByTimeAsync(1000);
      await expect(isBookmarkWriteGuardActive()).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases the mutex when persisting the guard fails', async () => {
    let failNextSet = true;
    const values: Record<string, unknown> = {};
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: values[key] }),
          set: async (next: Record<string, unknown>) => {
            if (failNextSet) {
              failNextSet = false;
              throw new Error('storage unavailable');
            }
            Object.assign(values, next);
          },
          remove: async (key: string) => delete values[key],
        },
      },
    });

    await expect(withBookmarkWriteMutex(async () => undefined)).rejects.toThrow(
      'storage unavailable',
    );
    await expect(withBookmarkWriteMutex(async () => 'next')).resolves.toBe(
      'next',
    );
  });
});
