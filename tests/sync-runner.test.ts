import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestSync } from '../src/adapters/sync-runner';

describe('sync runner integration', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('writes only on the first round and snapshots before every remote write', async () => {
    const values: Record<string, unknown> = {
      linkwardenSettings: {
        baseUrl: 'https://links.test',
        token: 'secret',
      },
      syncPreferences: {
        mode: 'additive-up',
        intervalMinutes: 15,
        dryRun: false,
      },
    };
    const operations: string[] = [];
    const remoteLinks: Array<Record<string, unknown>> = [];
    // "Unorganized" is Linkwarden's default collection; links at the top of
    // the bar end up there. Provide it up front so nothing has to be created.
    const collections: Array<Record<string, unknown>> = [
      { id: 124, name: 'Unorganized', ownerId: 1, parentId: null },
    ];
    const bookmarkTree: chrome.bookmarks.BookmarkTreeNode[] = [
      {
        id: 'root',
        title: '',
        syncing: false,
        children: [
          {
            id: 'bar',
            title: 'Lesezeichenleiste',
            syncing: false,
            children: [
              {
                id: 'bookmark',
                parentId: 'bar',
                title: 'Runner Test',
                url: 'https://example.com/runner-test',
                syncing: false,
              },
            ],
          },
          { id: 'other', title: 'Other', syncing: false, children: [] },
          { id: 'mobile', title: 'Mobil', syncing: false, children: [] },
        ],
      },
    ];

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
        getTree: vi.fn(async () => bookmarkTree),
      },
      notifications: { create: vi.fn(async () => 'notification') },
    });

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/api/v1/users/me') && method === 'GET') {
        return jsonResponse({ response: { id: 1 } });
      }
      if (url.includes('/api/v1/search?') && method === 'GET') {
        return jsonResponse({
          data: { links: remoteLinks, nextCursor: null },
        });
      }
      if (url.endsWith('/api/v1/collections') && method === 'GET') {
        return jsonResponse({ response: collections });
      }
      if (url.endsWith('/api/v1/collections') && method === 'POST') {
        operations.push('createCollection');
        const body = JSON.parse(String(init?.body));
        const collection = { id: 5, name: body.name, ownerId: 1 };
        collections.push(collection);
        return jsonResponse({ response: collection });
      }
      if (url.endsWith('/api/v1/links') && method === 'POST') {
        operations.push('createLink');
        const body = JSON.parse(String(init?.body));
        const link = {
          id: 9,
          name: body.name,
          url: body.url,
          type: 'url',
          tags: [{ id: 2, name: 'browser-sync' }],
          collection:
            body.collection === undefined
              ? null
              : { id: body.collection.id, name: 'Unorganized', ownerId: 1 },
        };
        remoteLinks.push(link);
        return jsonResponse({ response: link });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await requestSync('manual');

    expect(remoteLinks).toHaveLength(1);
    expect(operations).toEqual(['snapshot', 'createLink']);
    const firstState = values.syncState as {
      items: Record<string, { chromeId: string; lwLinkId: number }>;
    };
    expect(Object.values(firstState.items)).toMatchObject([
      { chromeId: 'bookmark', lwLinkId: 9 },
    ]);

    await requestSync('manual');

    expect(remoteLinks).toHaveLength(1);
    expect(operations).toEqual(['snapshot', 'createLink']);
    expect(values.syncJob).toBeUndefined();
    expect(values.syncStatus).toMatchObject({
      running: false,
      lastResult: 'ok',
      createdRemote: 0,
      updatedRemote: 0,
    });
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
