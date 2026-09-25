import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  approvePendingPlan,
  discardPendingPlan,
  getPendingPlan,
  requestSync,
  restoreSnapshot,
} from '../src/adapters/sync-runner';
import { createRemoteItem } from '../src/core/keys';

interface FakeLink {
  id: number;
  name: string;
  url: string;
  type: string;
  tags: Array<{ id: number; name: string }>;
  collection: { id: number; name: string; ownerId: number } | null;
}

interface Harness {
  values: Record<string, unknown>;
  links: FakeLink[];
  collections: Array<{ id: number; name: string; ownerId: number }>;
  tree: chrome.bookmarks.BookmarkTreeNode[];
  operations: string[];
}

function barTree(
  bar: chrome.bookmarks.BookmarkTreeNode[],
): chrome.bookmarks.BookmarkTreeNode[] {
  return [
    {
      id: 'root',
      title: '',
      syncing: false,
      children: [
        { id: 'bar', title: 'Lesezeichenleiste', syncing: false, children: bar },
        { id: 'other', title: 'Other', syncing: false, children: [] },
        { id: 'mobile', title: 'Mobil', syncing: false, children: [] },
      ],
    },
  ];
}

function install(options: {
  mode: 'additive-up' | 'additive-both' | 'bidirectional';
  dryRun?: boolean;
  bar?: chrome.bookmarks.BookmarkTreeNode[];
  links?: FakeLink[];
  collections?: Array<{ id: number; name: string; ownerId: number }>;
  state?: Record<string, unknown>;
}): Harness {
  const values: Record<string, unknown> = {
    linkwardenSettings: { baseUrl: 'https://links.test', token: 'secret' },
    syncPreferences: {
      mode: options.mode,
      intervalMinutes: 15,
      dryRun: options.dryRun ?? false,
    },
  };
  if (options.state !== undefined) {
    values.syncState = options.state;
  }
  const links = options.links ?? [];
  const collections = options.collections ?? [];
  for (const link of links) {
    const collection = link.collection;
    if (
      collection !== null &&
      !collections.some((candidate) => candidate.id === collection.id)
    ) {
      collections.push({
        id: collection.id,
        name: collection.name,
        ownerId: collection.ownerId,
      });
    }
  }
  const tree = barTree(options.bar ?? []);
  const operations: string[] = [];
  let nextBookmarkId = 1000;

  const find = (
    id: string,
    entries = tree,
  ): chrome.bookmarks.BookmarkTreeNode | undefined => {
    for (const entry of entries) {
      if (entry.id === id) return entry;
      const nested = find(id, entry.children ?? []);
      if (nested !== undefined) return nested;
    }
    return undefined;
  };
  const removeFrom = (id: string, entries = tree): boolean => {
    for (const entry of entries) {
      const children = entry.children;
      if (children === undefined) continue;
      const index = children.findIndex((child) => child.id === id);
      if (index >= 0) {
        children.splice(index, 1);
        return true;
      }
      if (removeFrom(id, children)) return true;
    }
    return false;
  };

  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: values[key] })),
        set: vi.fn(async (next: Record<string, unknown>) => {
          if ('syncSnapshots' in next) operations.push('snapshot');
          Object.assign(values, next);
        }),
        remove: vi.fn(async (key: string) => delete values[key]),
      },
    },
    bookmarks: {
      getTree: vi.fn(async () => tree),
      create: vi.fn(async (details: chrome.bookmarks.CreateDetails) => {
        operations.push(details.url === undefined ? 'createFolder' : 'createBookmark');
        const node: chrome.bookmarks.BookmarkTreeNode = {
          id: String(nextBookmarkId++),
          title: details.title ?? '',
          syncing: false,
          ...(details.parentId === undefined ? {} : { parentId: details.parentId }),
          ...(details.url === undefined ? { children: [] } : { url: details.url }),
        };
        const parent = find(details.parentId ?? '');
        (parent?.children ?? []).push(node);
        return node;
      }),
      update: vi.fn(async (id: string, changes: chrome.bookmarks.UpdateChanges) => {
        operations.push('updateBookmark');
        const node = find(id);
        if (node === undefined) throw new Error('missing bookmark');
        if (changes.title !== undefined) node.title = changes.title;
        if (changes.url !== undefined) node.url = changes.url;
        return node;
      }),
      move: vi.fn(async (id: string, dest: chrome.bookmarks.MoveDestination) => {
        const node = find(id);
        if (node === undefined) throw new Error('missing bookmark');
        removeFrom(id);
        if (dest.parentId !== undefined) node.parentId = dest.parentId;
        find(dest.parentId ?? '')?.children?.push(node);
        return node;
      }),
      remove: vi.fn(async (id: string) => {
        operations.push('removeBookmark');
        removeFrom(id);
      }),
      removeTree: vi.fn(async (id: string) => {
        operations.push('removeTree');
        removeFrom(id);
      }),
    },
    notifications: { create: vi.fn(async () => 'notification') },
  });

  let nextLinkId = 100;
  let nextCollectionId = 10;
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/api/v1/users/me') && method === 'GET') {
      return json({ response: { id: 1 } });
    }
    if (url.includes('/api/v1/search?') && method === 'GET') {
      return json({
        data: {
          links: links.map((link) => ({ ...link })),
          nextCursor: null,
        },
      });
    }
    if (url.endsWith('/api/v1/collections') && method === 'GET') {
      return json({ response: collections });
    }
    if (url.endsWith('/api/v1/collections') && method === 'POST') {
      operations.push('createCollection');
      const body = JSON.parse(String(init?.body));
      const collection = { id: nextCollectionId++, name: body.name, ownerId: 1 };
      collections.push(collection);
      return json({ response: collection });
    }
    if (url.endsWith('/api/v1/links') && method === 'POST') {
      operations.push('createLink');
      const body = JSON.parse(String(init?.body));
      const link: FakeLink = {
        id: nextLinkId++,
        name: body.name,
        url: body.url,
        type: 'url',
        tags: [{ id: 2, name: 'browser-sync' }],
        collection:
          body.collection === undefined
            ? null
            : (collections.find(
                (collection) => collection.id === body.collection.id,
              ) ?? null),
      };
      links.push(link);
      return json({ response: link });
    }
    const linkMatch = /\/api\/v1\/links\/(\d+)$/.exec(url);
    if (linkMatch !== null) {
      const id = Number(linkMatch[1]);
      if (method === 'GET') {
        const link = links.find((entry) => entry.id === id);
        if (link === undefined) return json({ response: null }, 404);
        return json({ response: link });
      }
      if (method === 'PUT') {
        operations.push('updateLink');
        const body = JSON.parse(String(init?.body));
        const link = links.find((entry) => entry.id === id);
        if (link === undefined) return json({ response: null }, 404);
        link.name = body.name;
        link.url = body.url;
        return json({ response: link });
      }
      if (method === 'DELETE') {
        operations.push('deleteLink');
        const index = links.findIndex((entry) => entry.id === id);
        if (index >= 0) links.splice(index, 1);
        return json({ response: {} });
      }
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);

  return { values, links, collections, tree, operations };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function bookmark(
  id: string,
  title: string,
  url: string,
): chrome.bookmarks.BookmarkTreeNode {
  return { id, parentId: 'bar', title, url, syncing: false };
}

function remoteLink(
  id: number,
  name: string,
  url: string,
  collectionName = '',
): FakeLink {
  return {
    id,
    name,
    url,
    type: 'url',
    tags: [{ id: 1, name: 'browser-sync' }],
    collection: { id: 5, name: collectionName, ownerId: 1 },
  };
}

// A remote link whose collection matches a local bar-root bookmark's folder
// path. A bookmark directly under the bar canonicalizes to the empty remote
// path (Unorganized / no collection), so collection: null makes
// localHash === remoteHash.
function matchingRemoteLink(id: number, name: string, url: string): FakeLink {
  return { ...remoteLink(id, name, url), collection: null };
}

function syncedItems(harness: Harness): Record<string, { chromeId: string | null; lwLinkId: number | null }> {
  const state = harness.values.syncState as {
    items: Record<string, { chromeId: string | null; lwLinkId: number | null }>;
  };
  return state.items;
}

describe('additive-both sync', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('mirrors a remote link into the bar collection tree and does not duplicate on repeat', async () => {
    const harness = install({
      mode: 'additive-both',
      links: [remoteLink(100, 'Docs', 'https://docs.example/', 'Dev')],
    });

    await requestSync('manual');

    const created = harness.operations.filter((op) => op === 'createBookmark');
    expect(created).toHaveLength(1);
    // Remote collection "Dev" -> local folder "Bookmarks Bar/Dev".
    const devFolder = harness.tree[0]?.children?.[0]?.children?.find(
      (child) => child.title === 'Dev',
    );
    expect(devFolder).toBeDefined();
    expect(Object.values(syncedItems(harness))).toHaveLength(1);

    harness.operations.length = 0;
    await requestSync('manual');

    expect(harness.operations.filter((op) => op === 'createBookmark')).toHaveLength(0);
    expect(harness.links).toHaveLength(1);
    expect(Object.values(syncedItems(harness))).toHaveLength(1);
  });

  it('maps a remote link in the Unorganized collection to the bar root and stays stable', async () => {
    // Real server state: links at the top of the bar live in the default
    // collection "Unorganized" (not null). They must map to the empty path so
    // they sit 1:1 in the bar and are neither duplicated nor updated on the
    // next sync.
    const harness = install({
      mode: 'additive-both',
      collections: [{ id: 124, name: 'Unorganized', ownerId: 1 }],
      links: [
        {
          id: 100,
          name: 'Root Doc',
          url: 'https://root.example/',
          type: 'url',
          tags: [{ id: 1, name: 'browser-sync' }],
          collection: { id: 124, name: 'Unorganized', ownerId: 1 },
        },
      ],
    });

    await requestSync('manual');

    // Exactly one bookmark, directly in the bar (no subfolder).
    expect(harness.operations.filter((op) => op === 'createBookmark')).toHaveLength(1);
    expect(harness.operations).not.toContain('createFolder');
    expect(Object.values(syncedItems(harness))).toHaveLength(1);

    harness.operations.length = 0;
    await requestSync('manual');

    // Stable: no new create, no update, no new remote link.
    expect(harness.operations).not.toContain('createBookmark');
    expect(harness.operations).not.toContain('updateLink');
    expect(harness.operations).not.toContain('createLink');
    expect(harness.links).toHaveLength(1);
  });

  it('does not delete a locally removed bookmark in additive mode', async () => {
    const harness = install({
      mode: 'additive-both',
      links: [remoteLink(100, 'Keep', 'https://keep.example/')],
    });
    await requestSync('manual');
    expect(harness.operations).not.toContain('deleteLink');
    expect(harness.links).toHaveLength(1);
  });

  it('ignores links from a collection owned by another Linkwarden user', async () => {
    const shared = remoteLink(
      222,
      'Shared',
      'https://shared.example/',
      'Shared Team',
    );
    shared.collection = {
      id: 55,
      name: 'Shared Team',
      ownerId: 2,
    };
    const harness = install({ mode: 'additive-both', links: [shared] });

    await requestSync('manual');

    expect(harness.operations).not.toContain('createBookmark');
    expect(Object.values(syncedItems(harness))).toEqual([]);
  });

  it('blocks on a malformed numeric remote record instead of creating a duplicate', async () => {
    const malformed = {
      id: 333,
      name: 'Malformed',
      url: 'https://malformed.example/',
      type: 'url',
      collection: null,
    } as unknown as FakeLink;
    const harness = install({
      mode: 'additive-both',
      bar: [bookmark('malformed-local', 'Malformed', malformed.url)],
      links: [malformed],
    });

    await expect(requestSync('manual')).rejects.toThrow(
      'remote inventory is incomplete',
    );
    expect(harness.operations).not.toContain('createLink');
  });

  it('decodes escaped local folder segments before creating collections', async () => {
    const folder: chrome.bookmarks.BookmarkTreeNode = {
      id: 'slash-folder',
      parentId: 'bar',
      title: 'A/B%',
      syncing: false,
      children: [
        {
          id: 'slash-bookmark',
          parentId: 'slash-folder',
          title: 'Escaped',
          url: 'https://escaped.example/',
          syncing: false,
        },
      ],
    };
    const harness = install({ mode: 'additive-up', bar: [folder] });

    await requestSync('manual');

    expect(harness.collections.some((entry) => entry.name === 'A/B%')).toBe(
      true,
    );
    expect(
      harness.collections.some((entry) => entry.name === 'A%2FB%25'),
    ).toBe(false);
  });

  it('resumes without duplicating after an interrupted create-remote', async () => {
    // Simulate a crash: a bookmark was uploaded on a prior run (remote link
    // exists) but syncState never recorded it because the worker died before
    // persisting. A fresh run must reconcile, not create a second link.
    const harness = install({
      mode: 'additive-up',
      bar: [bookmark('bm-1', 'Docs', 'https://docs.example/')],
    });
    // Pretend the interrupted run already created the remote link.
    harness.links.push({
      id: 500,
      name: 'Docs',
      url: 'https://docs.example',
      type: 'url',
      tags: [{ id: 1, name: 'browser-sync' }],
      collection: null,
    });
    harness.collections.push({ id: 5, name: 'Floccus', ownerId: 1 });
    harness.operations.length = 0;

    await requestSync('manual');

    // No new link, existing one reconciled into state.
    expect(harness.operations).not.toContain('createLink');
    expect(harness.links).toHaveLength(1);
    expect(Object.values(syncedItems(harness))).toHaveLength(1);
  });
});

describe('bidirectional sync', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('deletes a previously synced remote link even if its sync tag is missing', async () => {
    const link = matchingRemoteLink(
      90,
      'Legacy',
      'https://legacy.example/',
    );
    link.tags = [];
    const remote = await createRemoteItem({
      lwLinkId: link.id,
      url: link.url,
      title: link.name,
      folderPath: '',
      tags: [],
    });
    const harness = install({
      mode: 'bidirectional',
      links: [link],
      state: {
        schemaVersion: 1,
        items: {
          [remote.stableKey]: {
            stableKey: remote.stableKey,
            chromeId: 'bm-legacy',
            lwLinkId: remote.lwLinkId,
            url: remote.url,
            title: remote.title,
            folderPath: remote.folderPath,
            contentHash: remote.contentHash,
            lastSyncedAt: 1,
          },
        },
        folders: {},
        lastSyncAt: 1,
        lastResult: 'ok',
      },
    });

    await requestSync('manual');

    expect(harness.operations).toContain('deleteLink');
    expect(harness.links).toEqual([]);
    expect(Object.values(syncedItems(harness))).toEqual([]);
  });

  it('removes a remote link that was previously synced but is now locally absent', async () => {
    // Seed state as if a prior sync mapped both URLs.
    const state = {
      schemaVersion: 1,
      items: {},
      folders: {},
      lastSyncAt: 1,
      lastResult: 'ok',
    };
    const harness = install({
      mode: 'bidirectional',
      bar: [bookmark('bm-keep', 'Keep', 'https://keep.example/')],
      links: [
        matchingRemoteLink(100, 'Keep', 'https://keep.example/'),
        remoteLink(200, 'Gone', 'https://gone.example/'),
      ],
      state,
    });

    // Round 1 with empty state: both remote links download under the bar.
    await requestSync('manual');
    const afterFirst = Object.values(syncedItems(harness));
    expect(afterFirst).toHaveLength(2);

    // Now remove the "Gone" bookmark locally (it sits directly under the bar).
    const bar = harness.tree[0]?.children?.[0];
    if (bar?.children !== undefined) {
      bar.children = bar.children.filter((child) => child.title !== 'Gone');
    }
    harness.operations.length = 0;

    // Round 2: the known item is now locally absent -> deleteRemote.
    await requestSync('manual');
    expect(harness.operations).toContain('deleteLink');
    expect(harness.links.some((link) => link.url === 'https://gone.example/')).toBe(false);
    expect(harness.links.some((link) => link.url === 'https://keep.example/')).toBe(true);
  });

  it('is idempotent: a second sync with no changes performs zero write operations', async () => {
    // This guards against the auto-sync feedback loop: debounced bookmark
    // events (including ones fired by Syncwarden's own writes) trigger extra
    // syncs. Those must be no-ops when local and remote already match.
    const harness = install({
      mode: 'bidirectional',
      bar: [
        bookmark('bm-1', 'One', 'https://one.example/'),
        bookmark('bm-2', 'Two', 'https://two.example/'),
      ],
      links: [
        matchingRemoteLink(601, 'One', 'https://one.example/'),
        matchingRemoteLink(602, 'Two', 'https://two.example/'),
      ],
    });

    // Round 1: reconcile everything into state.
    await requestSync('manual');
    expect(Object.values(syncedItems(harness))).toHaveLength(2);
    harness.operations.length = 0;

    // Round 2 (simulating a debounced re-trigger): nothing changed.
    await requestSync('manual');
    expect(harness.operations).toEqual([]);

    // Round 3 for good measure: still stable.
    await requestSync('manual');
    expect(harness.operations).toEqual([]);
    expect(harness.links).toHaveLength(2);
  });

  it('fails closed when a tracked remote link is skipped by the inventory', async () => {
    const tracked = await createRemoteItem({
      lwLinkId: 777,
      url: 'https://unsafe.example/document.pdf',
      title: 'Tracked PDF',
      folderPath: '',
      tags: ['browser-sync'],
    });
    const harness = install({
      mode: 'bidirectional',
      links: [
        {
          id: 777,
          name: 'Tracked PDF',
          url: tracked.url,
          type: 'pdf',
          tags: [{ id: 1, name: 'browser-sync' }],
          collection: null,
        },
      ],
      state: {
        schemaVersion: 1,
        items: {
          [tracked.stableKey]: {
            stableKey: tracked.stableKey,
            chromeId: null,
            lwLinkId: tracked.lwLinkId,
            url: tracked.url,
            title: tracked.title,
            folderPath: tracked.folderPath,
            contentHash: tracked.contentHash,
            lastSyncedAt: 1,
          },
        },
        folders: {},
        lastSyncAt: 1,
        lastResult: 'ok',
      },
    });

    await expect(requestSync('manual')).rejects.toThrow(
      'remote inventory is incomplete',
    );
    expect(harness.operations).not.toContain('deleteLink');
    expect(harness.operations).not.toContain('createBookmark');
  });
});

describe('deletion brake and approval', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('blocks a large deletion plan and executes it only after approval', async () => {
    // Seed 30 known items locally + remotely, then drop 20 locally.
    const bar: chrome.bookmarks.BookmarkTreeNode[] = [];
    const links: FakeLink[] = [];
    for (let i = 0; i < 30; i += 1) {
      const url = `https://item.example/${i}`;
      bar.push(bookmark(`bm-${i}`, `Item ${i}`, url));
      links.push(matchingRemoteLink(300 + i, `Item ${i}`, url));
    }
    const harness = install({ mode: 'bidirectional', bar, links });

    // Round 1: build state with all 30 known (localHash === remoteHash -> no action).
    await requestSync('manual');
    expect(Object.values(syncedItems(harness))).toHaveLength(30);

    // Drop 20 local bookmarks.
    const barNode = harness.tree[0]?.children?.[0];
    if (barNode?.children !== undefined) {
      barNode.children = barNode.children.filter((_, index) => index >= 20);
    }
    harness.operations.length = 0;

    // Round 2: 20 deletions > max(5, 3) -> blocked, nothing deleted.
    await requestSync('manual');
    expect(harness.operations).not.toContain('deleteLink');
    const pending = await getPendingPlan();
    expect(pending).not.toBeNull();
    expect(pending?.job.plan?.deletionCount).toBe(20);
    expect(harness.links).toHaveLength(30);

    // Approve -> deletions run.
    await approvePendingPlan();
    expect(await getPendingPlan()).toBeNull();
    expect(harness.links).toHaveLength(10);
  });

  it('discards a blocked plan without touching remote', async () => {
    const bar: chrome.bookmarks.BookmarkTreeNode[] = [];
    const links: FakeLink[] = [];
    for (let i = 0; i < 30; i += 1) {
      const url = `https://drop.example/${i}`;
      bar.push(bookmark(`bm-${i}`, `Item ${i}`, url));
      links.push(matchingRemoteLink(400 + i, `Item ${i}`, url));
    }
    const harness = install({ mode: 'bidirectional', bar, links });
    await requestSync('manual');
    const barNode = harness.tree[0]?.children?.[0];
    if (barNode?.children !== undefined) barNode.children = [];
    await requestSync('manual');
    expect(await getPendingPlan()).not.toBeNull();

    await discardPendingPlan();
    expect(await getPendingPlan()).toBeNull();
    expect(harness.links).toHaveLength(30);
  });

  it('requires another review when inventory changes before approval', async () => {
    const bar: chrome.bookmarks.BookmarkTreeNode[] = [];
    const links: FakeLink[] = [];
    for (let index = 0; index < 30; index += 1) {
      const url = `https://stale.example/${index}`;
      bar.push(bookmark(`stale-${index}`, `Item ${index}`, url));
      links.push(matchingRemoteLink(800 + index, `Item ${index}`, url));
    }
    const harness = install({ mode: 'bidirectional', bar, links });
    await requestSync('manual');
    const barNode = harness.tree[0]?.children?.[0];
    if (barNode?.children !== undefined) {
      barNode.children = barNode.children.filter((_, index) => index >= 20);
    }
    await requestSync('manual');
    expect((await getPendingPlan())?.job.plan?.deletionCount).toBe(20);

    barNode?.children?.push(
      bookmark('stale-returned', 'Item 0', 'https://stale.example/0'),
    );
    harness.operations.length = 0;
    await approvePendingPlan();

    expect(harness.operations).not.toContain('deleteLink');
    expect((await getPendingPlan())?.job.plan?.deletionCount).toBe(19);
    await approvePendingPlan();
    expect(await getPendingPlan()).toBeNull();
    expect(harness.links).toHaveLength(11);
  });
});

describe('snapshot restore', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('restores the local tree captured before a write', async () => {
    const harness = install({
      mode: 'additive-both',
      links: [remoteLink(100, 'Docs', 'https://docs.example/', 'Dev')],
    });
    await requestSync('manual');

    // A snapshot was taken before the create; it captured the empty tree.
    const snapshots = harness.values.syncSnapshots as Array<{ id: string }>;
    expect(snapshots.length).toBeGreaterThan(0);
    const oldest = snapshots[snapshots.length - 1];

    // Mutate the tree further, then restore to the pre-write snapshot.
    await restoreSnapshot(oldest!.id);

    const devFolder = harness.tree[0]?.children?.[0]?.children?.find(
      (child) => child.title === 'Dev',
    );
    expect(devFolder).toBeUndefined();
    expect(harness.operations).toContain('removeTree');
  });
});

describe('dry-run', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('plans but writes nothing when dry-run is enabled', async () => {
    const harness = install({
      mode: 'additive-both',
      dryRun: true,
      links: [remoteLink(100, 'Docs', 'https://docs.example/', 'Dev')],
    });
    await requestSync('manual');
    expect(harness.operations).not.toContain('createBookmark');
    expect(harness.values.syncState).toBeUndefined();
    const log = harness.values.syncLog as Array<{ type: string }>;
    expect(log.some((entry) => entry.type === 'dryRun')).toBe(true);
  });
});
