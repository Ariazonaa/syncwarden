import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSnapshot,
  listSnapshots,
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
