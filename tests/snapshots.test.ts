import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSnapshot,
  listSnapshots,
  restoreLocalTree,
  type SyncSnapshot,
} from '../src/adapters/snapshots';
import { createEmptySyncState } from '../src/core/types';

function installChromeStorage(initial: unknown[] = []) {
  const values: Record<string, unknown> = { syncSnapshots: initial };
  const local = {
    get: vi.fn(async (key: string) => ({ [key]: values[key] })),
    set: vi.fn(async (next: Record<string, unknown>) => Object.assign(values, next)),
  };
  const tree: chrome.bookmarks.BookmarkTreeNode[] = [
    {
      id: 'root',
      title: '',
      syncing: false,
      children: [
        { id: 'bar', title: 'Bar', syncing: false, children: [] },
      ],
    },
  ];
  vi.stubGlobal('chrome', {
    storage: { local },
    bookmarks: { getTree: vi.fn(async () => tree) },
  });
  return { values, local, tree };
}

describe('snapshots', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('captures the full local tree, remote before-data and state', async () => {
    const fake = installChromeStorage();
    const state = createEmptySyncState();
    const snapshot = await createSnapshot({
      reason: 'before-write',
      remoteBefore: [],
      state,
      now: 42,
    });
    expect(snapshot).toMatchObject({
      createdAt: 42,
      reason: 'before-write',
      localTree: fake.tree,
      state,
    });
    expect(fake.local.set).toHaveBeenCalledTimes(1);
  });

  it('keeps only the three newest snapshots', async () => {
    installChromeStorage();
    for (let index = 0; index < 12; index += 1) {
      await createSnapshot({
        reason: `snapshot-${index}`,
        remoteBefore: [],
        state: createEmptySyncState(),
        now: index,
      });
    }
    const snapshots = await listSnapshots();
    expect(snapshots).toHaveLength(3);
    expect(snapshots[0]?.createdAt).toBe(11);
    expect(snapshots[2]?.createdAt).toBe(9);
  });

  it('fails closed when snapshot persistence fails', async () => {
    const fake = installChromeStorage();
    fake.local.set.mockRejectedValueOnce(new Error('quota exceeded'));
    await expect(
      createSnapshot({
        reason: 'before-write',
        remoteBefore: [],
        state: createEmptySyncState(),
      }),
    ).rejects.toThrow('quota exceeded');
  });

  it('stores remoteBefore in a slimmed shape to conserve storage quota', async () => {
    const fake = installChromeStorage();
    await createSnapshot({
      reason: 'before-write',
      remoteBefore: [
        {
          id: 42,
          name: 'Example',
          url: 'https://example.com/',
          description: 'a very long description that should not be persisted',
          icon: 'some-icon-data',
          color: '#fff',
          tags: [
            { id: 1, name: 'browser-sync' },
            { id: 2, name: 'keep' },
          ],
          collection: { id: 7, name: 'Dev', ownerId: 1, parentId: null },
        },
      ],
      state: createEmptySyncState(),
      now: 1,
    });
    const stored = (fake.values.syncSnapshots as Array<{ remoteBefore: unknown[] }>);
    expect(stored[0]?.remoteBefore).toEqual([
      {
        id: 42,
        url: 'https://example.com/',
        name: 'Example',
        collectionId: 7,
        collectionName: 'Dev',
        tags: ['browser-sync', 'keep'],
      },
    ]);
  });

  it('rejects a snapshot whose editable roots are bookmarks instead of folders', async () => {
    const malformed = {
      id: 'malformed',
      createdAt: 1,
      reason: 'malformed',
      localTree: [
        {
          id: 'root',
          title: '',
          children: [
            { id: 'bar', title: 'Bar', url: 'https://destructive.example/' },
          ],
        },
      ],
      remoteBefore: [],
      state: createEmptySyncState(),
    };
    installChromeStorage([malformed]);

    await expect(listSnapshots()).resolves.toEqual([]);
  });
});

function ffNode(
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

function ffSeparator(id: string): chrome.bookmarks.BookmarkTreeNode {
  return { ...ffNode(id, '', undefined, 'data:'), type: 'separator' } as chrome.bookmarks.BookmarkTreeNode;
}

function firefoxRoot(
  menu: chrome.bookmarks.BookmarkTreeNode[],
  toolbar: chrome.bookmarks.BookmarkTreeNode[],
): chrome.bookmarks.BookmarkTreeNode {
  return ffNode('root________', '', [
    ffNode('menu________', 'Lesezeichen-Menü', menu),
    ffNode('toolbar_____', 'Lesezeichen-Symbolleiste', toolbar),
    ffNode('unfiled_____', 'Weitere Lesezeichen', []),
    ffNode('mobile______', 'Mobile Lesezeichen', []),
  ]);
}

function restoreApi(live: chrome.bookmarks.BookmarkTreeNode) {
  let nextId = 1;
  return {
    getTree: vi.fn(async () => [live]),
    create: vi.fn(async (details: chrome.bookmarks.CreateDetails) =>
      ffNode(`new-${nextId++}`, details.title ?? '', details.url === undefined ? [] : undefined, details.url),
    ),
    removeTree: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  };
}

function snapshotOf(root: chrome.bookmarks.BookmarkTreeNode): SyncSnapshot {
  return {
    id: 's',
    createdAt: 1,
    reason: 'test',
    localTree: [root],
    remoteBefore: [],
    state: createEmptySyncState(),
  };
}

describe('snapshot restore across browsers', () => {
  it('restores Firefox roots by key, not by position', async () => {
    const saved = firefoxRoot(
      [ffNode('a', 'A', undefined, 'https://a.example/')],
      [ffNode('b', 'B', undefined, 'https://b.example/')],
    );
    const live = firefoxRoot([ffNode('x', 'X', undefined, 'https://x.example/')], []);
    const api = restoreApi(live);

    await restoreLocalTree(snapshotOf(saved), api);

    expect(api.remove).toHaveBeenCalledWith('x');
    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({ parentId: 'menu________', url: 'https://a.example/' }),
    );
    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({ parentId: 'toolbar_____', url: 'https://b.example/' }),
    );
  });

  it('restores the fourth Firefox root and ignores localized title changes', async () => {
    const saved = firefoxRoot([], []);
    const mobile = saved.children?.[3];
    if (mobile === undefined) throw new Error('fixture');
    mobile.children = [ffNode('m', 'M', undefined, 'https://m.example/')];
    const live = firefoxRoot([], []);
    for (const child of live.children ?? []) child.title = `${child.title} (en)`;
    const api = restoreApi(live);

    await restoreLocalTree(snapshotOf(saved), api);

    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({ parentId: 'mobile______', url: 'https://m.example/' }),
    );
  });

  it('recreates separators as separators', async () => {
    const saved = firefoxRoot([], [ffSeparator('sep')]);
    const api = restoreApi(firefoxRoot([], []));

    await restoreLocalTree(snapshotOf(saved), api);

    expect(api.create).toHaveBeenCalledWith({ parentId: 'toolbar_____', type: 'separator' });
  });

  it('refuses a Firefox snapshot on a Chromium tree before changing anything', async () => {
    const saved = firefoxRoot([ffNode('a', 'A', undefined, 'https://a.example/')], []);
    const chromium = ffNode('0', '', [
      ffNode('1', 'Bar', [ffNode('keep', 'Keep', undefined, 'https://keep.example/')]),
      ffNode('2', 'Other', []),
      ffNode('3', 'Mobile', []),
    ]);
    const api = restoreApi(chromium);

    await expect(restoreLocalTree(snapshotOf(saved), api)).rejects.toThrow(
      /root folders don’t match/,
    );
    expect(api.remove).not.toHaveBeenCalled();
    expect(api.removeTree).not.toHaveBeenCalled();
    expect(api.create).not.toHaveBeenCalled();
  });

  it('lists Firefox snapshots and Chromium snapshots without folderType', async () => {
    const firefox = snapshotOf(firefoxRoot([], [ffSeparator('sep')]));
    const chromium = {
      ...snapshotOf(ffNode('0', '', [ffNode('1', 'Bar', []), ffNode('2', 'Other', [])])),
      id: 'chromium',
    };
    installChromeStorage([firefox, chromium]);

    const listed = await listSnapshots();

    expect(listed.map((entry) => entry.id).sort()).toEqual(['chromium', 's']);
  });
});
