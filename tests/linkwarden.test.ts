import { describe, expect, it, vi } from 'vitest';
import {
  LinkwardenClient,
  LinkwardenHttpError,
  normalizeBaseUrl,
  permissionOrigin,
  SYNC_TAG,
  type LinkwardenCollection,
} from '../src/adapters/linkwarden';
import { createRemoteItem } from '../src/core/keys';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('normalizeBaseUrl', () => {
  it('normalizes whitespace and trailing slashes', () => {
    expect(normalizeBaseUrl(' https://links.example.test/// ')).toBe(
      'https://links.example.test',
    );
  });

  it('accepts an installation path', () => {
    expect(normalizeBaseUrl('https://example.test/linkwarden/')).toBe(
      'https://example.test/linkwarden',
    );
  });

  it('removes an accidentally entered API suffix', () => {
    expect(normalizeBaseUrl('https://example.test/api/v1')).toBe(
      'https://example.test',
    );
  });

  it('rejects unsupported protocols', () => {
    expect(() => normalizeBaseUrl('ftp://example.test')).toThrow(
      'https:// or http://',
    );
  });

  it('rejects query strings', () => {
    expect(() => normalizeBaseUrl('https://example.test?token=nope')).toThrow(
      'query parameters',
    );
  });

  it('creates an origin-only permission pattern', () => {
    expect(permissionOrigin('https://example.test/linkwarden')).toBe(
      'https://example.test/*',
    );
  });
});

describe('LinkwardenClient', () => {
  it('calls the global fetch without rebinding its receiver', async () => {
    const globalFetch = vi.fn(function (this: unknown, input: RequestInfo | URL) {
      if (this !== undefined) {
        throw new TypeError('Illegal invocation');
      }
      return Promise.resolve(
        String(input).endsWith('/users/me')
          ? response({ response: { id: 1 } })
          : response({ response: [] }),
      );
    });
    vi.stubGlobal('fetch', globalFetch);
    const client = new LinkwardenClient({
      baseUrl: 'https://example.test',
      token: 'secret',
    });
    await expect(client.testConnection()).resolves.toEqual([]);
    vi.unstubAllGlobals();
  });

  it('tests a connection through collections', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) =>
      String(input).endsWith('/users/me')
        ? response({ response: { id: 1 } })
        : response({ response: [{ id: 4, name: 'Dev' }] }),
    );
    const client = new LinkwardenClient(
      { baseUrl: 'https://example.test', token: 'secret' },
      fetchMock,
    );

    await expect(client.testConnection()).resolves.toEqual([
      { id: 4, name: 'Dev' },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.test/api/v1/collections',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer secret',
        }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.test/api/v1/users/me',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('creates one tagged URL link', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        response: {
          id: 7,
          name: 'Example',
          url: 'https://example.com/',
          tags: [{ id: 2, name: SYNC_TAG }],
        },
      }),
    );
    const client = new LinkwardenClient(
      { baseUrl: 'https://links.test', token: 'secret' },
      fetchMock,
    );

    await client.createLink({
      name: 'Example',
      url: 'https://example.com/',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0];
    expect(request?.[0]).toBe('https://links.test/api/v1/links');
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      name: 'Example',
      url: 'https://example.com/',
      tags: [{ name: SYNC_TAG }],
    });
  });

  it('turns 401 into a concrete token error', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      response({ response: 'Unauthorized' }, 401),
    );
    const client = new LinkwardenClient(
      { baseUrl: 'https://links.test', token: 'bad' },
      fetchMock,
    );

    await expect(client.testConnection()).rejects.toMatchObject({
      status: 401,
      message:
        'Token rejected (401). Check the access token in the Linkwarden settings.',
    } satisfies Partial<LinkwardenHttpError>);
  });

  it('rejects unknown successful response shapes', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ collections: [] }));
    const client = new LinkwardenClient(
      { baseUrl: 'https://links.test', token: 'secret' },
      fetchMock,
    );

    await expect(client.testConnection()).rejects.toThrow(
      'unknown format',
    );
  });

  it('reads a cursor-paginated links page into domain items with nested paths', async () => {
    // The search endpoint returns an authoritative cursor, whatever page size
    // the server is configured with.
    // The collection path is resolved via the parentId chain:
    // 3 (Dev) -> 2 (Projects) -> 1 (Root) gives "Root/Projects/Dev".
    const links = Array.from({ length: 50 }, (_unused, index) => ({
      id: 100 + index,
      name: `Item ${index}`,
      url: `https://example.com/${index}`,
      type: 'url',
      tags: [{ id: 2, name: SYNC_TAG }],
      collection: { id: 3, name: 'Dev', ownerId: 1 },
    }));
    links[0] = {
      id: 9,
      name: 'Docs',
      url: 'HTTPS://EXAMPLE.COM/docs/#top',
      type: 'url',
      tags: [{ id: 2, name: SYNC_TAG }],
      collection: { id: 3, name: 'Dev', ownerId: 1 },
    } as (typeof links)[number];
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      response({ data: { links, nextCursor: 149 } }),
    );
    const client = new LinkwardenClient(
      { baseUrl: 'https://links.test', token: 'secret' },
      fetchMock,
    );

    const byId = new Map<number, LinkwardenCollection>([
      [1, { id: 1, name: 'Root', parentId: null }],
      [2, { id: 2, name: 'Projects', parentId: 1 }],
      [3, { id: 3, name: 'Dev', parentId: 2 }],
    ]);

    const page = await client.listLinksPage(25, byId);

    expect(page.nextCursor).toBe(149);
    expect(page.records[0]?.item).toMatchObject({
      lwLinkId: 9,
      url: 'HTTPS://EXAMPLE.COM/docs/#top',
      folderPath: 'Root/Projects/Dev',
      tags: [SYNC_TAG],
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://links.test/api/v1/search?sort=0&cursor=25',
    );
  });

  it('skips non-url and unsupported remote entries', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        data: {
          links: [
            {
              id: 1,
              name: 'PDF',
              url: 'https://example.com/a.pdf',
              type: 'pdf',
              tags: [],
            },
            {
              id: 2,
              name: 'Local',
              url: 'file:///tmp/file',
              type: 'url',
              tags: [],
            },
          ],
          nextCursor: null,
        },
      }),
    );
    const client = new LinkwardenClient(
      { baseUrl: 'https://links.test', token: 'secret' },
      fetchMock,
    );
    const page = await client.listLinksPage(null, new Map());
    expect(page.records).toEqual([]);
    expect(page.skippedCount).toBe(2);
    expect(page.skippedIds).toEqual([1, 2]);
    expect(page.nextCursor).toBeNull();
  });

  it('falls back to legacy links and keeps paging until an empty page', async () => {
    const legacyLinks = [
      {
        id: 7,
        name: 'Legacy',
        url: 'https://example.com/legacy',
        type: 'url',
        tags: [],
      },
    ];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ response: 'Not Found' }, 404))
      .mockResolvedValueOnce(response({ response: legacyLinks }));
    const client = new LinkwardenClient(
      { baseUrl: 'https://links.test', token: 'secret' },
      fetchMock,
    );

    const page = await client.listLinksPage(null, new Map());

    expect(page.records).toHaveLength(1);
    expect(page.nextCursor).toBe(7);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://links.test/api/v1/links?sort=0',
    );
  });

  it('creates a flat collection through POST collections', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        response: { id: 12, name: 'Bookmarks Bar/Dev', ownerId: 1 },
      }),
    );
    const client = new LinkwardenClient(
      { baseUrl: 'https://links.test', token: 'secret' },
      fetchMock,
    );
    await expect(client.createCollection('Bookmarks Bar/Dev')).resolves.toEqual({
      id: 12,
      name: 'Bookmarks Bar/Dev',
      ownerId: 1,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://links.test/api/v1/collections',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'Bookmarks Bar/Dev' }),
      }),
    );
  });

  it('preserves remote metadata while updating from local', async () => {
    const existing = {
      id: 14,
      name: 'Before',
      url: 'https://example.com/update',
      description: 'Keep me',
      icon: 'Acorn',
      iconWeight: 'bold',
      color: '#123456',
      tags: [{ id: 3, name: 'existing' }],
      collection: { id: 2, name: 'Old', ownerId: 1 },
      pinnedBy: [{ id: 1 }],
    };
    const updated = {
      ...existing,
      name: 'After',
      tags: [...existing.tags, { id: 4, name: SYNC_TAG }],
      collection: { id: 7, name: 'Bookmarks Bar/Dev', ownerId: 1 },
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ response: existing }))
      .mockResolvedValueOnce(response({ response: updated }));
    const client = new LinkwardenClient(
      { baseUrl: 'https://links.test', token: 'secret' },
      fetchMock,
    );
    const localItem = {
      stableKey: 'key',
      chromeId: 'chrome',
      url: 'https://example.com/update',
      title: 'After',
      folderPath: 'Bookmarks Bar/Dev',
      contentHash: 'hash',
    };

    const expectedRemote = await createRemoteItem({
      lwLinkId: existing.id,
      url: existing.url,
      title: existing.name,
      folderPath: 'Old',
      tags: existing.tags.map((tag) => tag.name),
    });
    await client.updateLinkFromLocal(
      localItem,
      expectedRemote,
      {
        id: 7,
        name: 'Bookmarks Bar/Dev',
        ownerId: 1,
      },
      new Map([[2, existing.collection]]),
    );

    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(body).toMatchObject({
      id: 14,
      name: 'After',
      description: 'Keep me',
      icon: 'Acorn',
      collection: { id: 7, ownerId: 1 },
      pinnedBy: [{ id: 1 }],
    });
    expect(body.tags).toEqual([
      { id: 3, name: 'existing' },
      { name: SYNC_TAG },
    ]);
  });

  it('adopts an existing link by adding only the sync tag', async () => {
    const existing = {
      id: 42,
      name: 'Bestandslink',
      url: 'https://example.com/legacy',
      description: 'Original',
      icon: 'Acorn',
      iconWeight: 'bold',
      color: '#abcdef',
      tags: [{ id: 9, name: 'floccus' }],
      collection: { id: 3, name: 'keys', ownerId: 1 },
      pinnedBy: [{ id: 2 }],
    };
    const adopted = {
      ...existing,
      tags: [...existing.tags, { id: 10, name: SYNC_TAG }],
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ response: existing }))
      .mockResolvedValueOnce(response({ response: adopted }));
    const client = new LinkwardenClient(
      { baseUrl: 'https://links.test', token: 'secret' },
      fetchMock,
    );

    const expectedRemote = await createRemoteItem({
      lwLinkId: existing.id,
      url: existing.url,
      title: existing.name,
      folderPath: 'keys',
      tags: existing.tags.map((tag) => tag.name),
    });
    const result = await client.adoptLink(
      expectedRemote,
      new Map([[3, existing.collection]]),
    );

    // GET to load, then PUT to write back.
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/links/42');
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe('PUT');
    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    // Name, URL, collection and description stay the same.
    expect(body).toMatchObject({
      id: 42,
      name: 'Bestandslink',
      url: 'https://example.com/legacy',
      description: 'Original',
      collection: { id: 3, ownerId: 1 },
      pinnedBy: [{ id: 2 }],
    });
    // Only the sync tag is added, the existing one is kept.
    expect(body.tags).toEqual([
      { id: 9, name: 'floccus' },
      { name: SYNC_TAG },
    ]);
    expect(result.tags.some((tag) => tag.name === SYNC_TAG)).toBe(true);
  });

  it('does not delete a remote id whose metadata changed after planning', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        response: {
          id: 99,
          name: 'Reused target',
          url: 'https://planned.example/',
          type: 'url',
          tags: [],
        },
      }),
    );
    const client = new LinkwardenClient(
      { baseUrl: 'https://links.test', token: 'secret' },
      fetchMock,
    );

    const expectedRemote = await createRemoteItem({
      lwLinkId: 99,
      url: 'https://planned.example/',
      title: 'Planned',
      folderPath: '',
      tags: [],
    });
    await expect(client.deleteLink(expectedRemote, new Map())).rejects.toThrow(
      'changed since the plan was made',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('GET');
  });

  it('treats an already missing planned remote deletion as idempotent', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ response: 'Not Found' }, 404));
    const client = new LinkwardenClient(
      { baseUrl: 'https://links.test', token: 'secret' },
      fetchMock,
    );

    const expectedRemote = await createRemoteItem({
      lwLinkId: 100,
      url: 'https://gone.example/',
      title: 'Gone',
      folderPath: '',
      tags: [],
    });
    await expect(
      client.deleteLink(expectedRemote, new Map()),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
