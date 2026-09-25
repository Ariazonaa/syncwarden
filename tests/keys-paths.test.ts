import { describe, expect, it } from 'vitest';
import {
  contentHash,
  createLocalItem,
  createRemoteItem,
  normalizeUrl,
  stableKey,
  UnsupportedBookmarkUrlError,
} from '../src/core/keys';
import {
  escapePathSegment,
  joinFolderPath,
  LINKWARDEN_LOCAL_ROOT,
  localMirrorPathToRemotePath,
  normalizeFolderPath,
  remotePathToLocalPath,
} from '../src/core/paths';

describe('normalizeUrl', () => {
  it('lowercases protocol and host', () => {
    expect(normalizeUrl('HTTPS://EXAMPLE.COM/Path')).toBe(
      'https://example.com/Path',
    );
  });

  it('removes a trailing slash for an empty path', () => {
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com');
  });

  it('keeps a non-empty trailing slash', () => {
    expect(normalizeUrl('https://example.com/docs/')).toBe(
      'https://example.com/docs/',
    );
  });

  it('removes fragments', () => {
    expect(normalizeUrl('https://example.com/page#section')).toBe(
      'https://example.com/page',
    );
  });

  it('removes every specified tracking parameter case-insensitively', () => {
    expect(
      normalizeUrl(
        'https://example.com?a=1&utm_source=x&UTM_MEDIUM=y&fbclid=z&gclid=z&mc_eid=z',
      ),
    ).toBe('https://example.com?a=1');
  });

  it('keeps the ambiguous "ref" parameter (not treated as tracking)', () => {
    // "ref" is NOT clearly tracking (git branch, API reference, docs anchor)
    // and must not merge different links into the same stableKey.
    expect(normalizeUrl('https://example.com?ref=main')).toBe(
      'https://example.com?ref=main',
    );
    expect(normalizeUrl('https://example.com?ref=main')).not.toBe(
      normalizeUrl('https://example.com?ref=dev'),
    );
  });

  it('keeps and alphabetically sorts ordinary query parameters', () => {
    expect(normalizeUrl('https://example.com?z=2&a=3&a=1&m=4')).toBe(
      'https://example.com?a=1&a=3&m=4&z=2',
    );
  });

  it('normalizes default ports through URL parsing', () => {
    expect(normalizeUrl('https://example.com:443/path')).toBe(
      'https://example.com/path',
    );
  });

  it.each(['file:///tmp/test', 'chrome://settings', 'javascript:alert(1)'])(
    'rejects unsupported URL %s',
    (url) => {
      expect(() => normalizeUrl(url)).toThrow(UnsupportedBookmarkUrlError);
    },
  );

  it.each([
    'https://user@example.com/private',
    'https://user:secret@example.com/private',
    'https://:secret@example.com/private',
  ])('rejects embedded credentials in %s', (url) => {
    expect(() => normalizeUrl(url)).toThrow(UnsupportedBookmarkUrlError);
    expect(() => normalizeUrl(url)).toThrow(
      'URLs with embedded credentials are not supported.',
    );
  });
});

describe('hashing', () => {
  it('uses the normalized URL for stable keys', async () => {
    await expect(
      Promise.all([
        stableKey('HTTPS://EXAMPLE.COM/?utm_source=test'),
        stableKey('https://example.com'),
      ]),
    ).resolves.toSatisfy(([left, right]) => left === right);
  });

  it('returns a lowercase SHA-256 hex key', async () => {
    await expect(stableKey('https://example.com')).resolves.toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it('changes content hash when the title changes', async () => {
    const left = await contentHash('https://example.com', 'One', 'Dev');
    const right = await contentHash('https://example.com', 'Two', 'Dev');
    expect(left).not.toBe(right);
  });

  it('changes content hash when the folder path changes', async () => {
    const left = await contentHash('https://example.com', 'One', 'Dev');
    const right = await contentHash('https://example.com', 'One', 'Work');
    expect(left).not.toBe(right);
  });

  it.each([
    [
      'fragment',
      'https://example.com/page#one',
      'https://example.com/page#two',
    ],
    [
      'tracking query',
      'https://example.com/page?utm_source=one',
      'https://example.com/page?utm_source=two',
    ],
    [
      'query order',
      'https://example.com/page?a=1&b=2',
      'https://example.com/page?b=2&a=1',
    ],
  ])(
    'keeps one stable key but detects a changed %s as changed content',
    async (_case, leftUrl, rightUrl) => {
      const left = await createLocalItem({
        chromeId: '1',
        url: leftUrl,
        title: 'Page',
        folderPath: 'Bookmarks Bar',
      });
      const right = await createRemoteItem({
        lwLinkId: 2,
        url: rightUrl,
        title: 'Page',
        folderPath: 'Bookmarks Bar',
      });

      expect(left.stableKey).toBe(right.stableKey);
      expect(left.contentHash).not.toBe(right.contentHash);
    },
  );
});

describe('synchronized URLs', () => {
  it('preserves the original URL including fragment, query parameters and order', async () => {
    const url =
      'HTTPS://EXAMPLE.COM/Path?z=2&utm_source=test&a=1#documentation';

    const [local, remote] = await Promise.all([
      createLocalItem({
        chromeId: '1',
        url,
        title: 'Page',
        folderPath: 'Bookmarks Bar',
      }),
      createRemoteItem({
        lwLinkId: 2,
        url,
        title: 'Page',
        folderPath: 'Bookmarks Bar',
      }),
    ]);

    expect(local.url).toBe(url);
    expect(remote.url).toBe(url);
  });
});

describe('folder paths', () => {
  it('prefixes every browser root with a stable logical name', () => {
    expect(joinFolderPath('bar', ['Dev', 'Rust'])).toBe(
      'Bookmarks Bar/Dev/Rust',
    );
    expect(joinFolderPath('other', [])).toBe('Other Bookmarks');
    expect(joinFolderPath('mobile', ['Read'])).toBe('Mobile Bookmarks/Read');
  });

  it('escapes slash and percent inside folder names', () => {
    expect(escapePathSegment('A/B%')).toBe('A%2FB%25');
  });

  it('maps remote paths below the dedicated local mirror', () => {
    // Linkwarden's top level maps straight to the mirror root.
    expect(remotePathToLocalPath('Dev/Rust')).toBe(
      `${LINKWARDEN_LOCAL_ROOT}/Dev/Rust`,
    );
    expect(remotePathToLocalPath('')).toBe(LINKWARDEN_LOCAL_ROOT);
    // Collections are subfolders of the mirror root.
    expect(remotePathToLocalPath('Sonstiges')).toBe(
      `${LINKWARDEN_LOCAL_ROOT}/Sonstiges`,
    );
  });

  it('maps local mirror paths back to remote paths', () => {
    // Everything below the mirror root maps directly into collection space.
    expect(
      localMirrorPathToRemotePath(`${LINKWARDEN_LOCAL_ROOT}/Dev/Rust`),
    ).toBe('Dev/Rust');
    // The mirror root itself is Linkwarden's top level (empty path).
    expect(localMirrorPathToRemotePath('Bookmarks Bar')).toBe('');
    expect(localMirrorPathToRemotePath('Bookmarks Bar/keys')).toBe('keys');
    // Other roots (Other/Mobile Bookmarks) are NOT part of the mirror -> null.
    expect(localMirrorPathToRemotePath('Other Bookmarks/Private')).toBeNull();
    expect(localMirrorPathToRemotePath('Mobile Bookmarks/Read')).toBeNull();
  });

  it('normalizes repeated separators and whitespace', () => {
    expect(normalizeFolderPath(' / Dev // Rust / ')).toBe('Dev/Rust');
  });
});
