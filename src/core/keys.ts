import type {
  FolderPath,
  LocalItem,
  RemoteItem,
  StableKey,
} from './types';

const TRACKING_PARAMETERS = new Set([
  'fbclid',
  'gclid',
  'mc_eid',
]);

export class UnsupportedBookmarkUrlError extends Error {
  constructor(protocol: string, reason?: string) {
    super(reason ?? `Unsupported URL scheme: ${protocol}`);
    this.name = 'UnsupportedBookmarkUrlError';
  }
}

export function normalizeUrl(input: string): string {
  const url = new URL(input);
  const protocol = url.protocol.toLowerCase();

  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new UnsupportedBookmarkUrlError(protocol);
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new UnsupportedBookmarkUrlError(
      protocol,
      'URLs with embedded credentials are not supported.',
    );
  }

  url.protocol = protocol;
  url.hostname = url.hostname.toLowerCase();
  url.hash = '';

  const queryEntries = [...url.searchParams.entries()]
    .filter(([name]) => !isTrackingParameter(name))
    .sort(([leftName, leftValue], [rightName, rightValue]) => {
      const nameOrder = compareText(leftName, rightName);
      return nameOrder === 0 ? compareText(leftValue, rightValue) : nameOrder;
    });

  url.search = '';
  for (const [name, value] of queryEntries) {
    url.searchParams.append(name, value);
  }

  const pathname = url.pathname === '/' ? '' : url.pathname;
  return `${url.protocol}//${url.host}${pathname}${url.search}`;
}

export async function stableKey(input: string): Promise<StableKey> {
  return sha256(normalizeUrl(input));
}

export async function contentHash(
  url: string,
  title: string,
  folderPath: FolderPath,
): Promise<string> {
  // URL.toString() only normalizes spellings that are syntactically the same
  // (e.g. host case and the implicit root /), but keeps the fragment,
  // tracking parameters and query order as content worth syncing.
  const contentUrl = new URL(url).toString();
  return sha256(`${contentUrl}\u0000${title}\u0000${folderPath}`);
}

export async function createLocalItem(input: {
  chromeId: string;
  url: string;
  title: string;
  folderPath: FolderPath;
}): Promise<LocalItem> {
  const normalizedKeyUrl = normalizeUrl(input.url);
  return {
    stableKey: await sha256(normalizedKeyUrl),
    chromeId: input.chromeId,
    url: input.url,
    title: input.title,
    folderPath: input.folderPath,
    contentHash: await contentHash(input.url, input.title, input.folderPath),
  };
}

export async function createRemoteItem(input: {
  lwLinkId: number;
  url: string;
  title: string;
  folderPath: FolderPath;
  tags?: string[];
}): Promise<RemoteItem> {
  const normalizedKeyUrl = normalizeUrl(input.url);
  return {
    stableKey: await sha256(normalizedKeyUrl),
    lwLinkId: input.lwLinkId,
    url: input.url,
    title: input.title,
    folderPath: input.folderPath,
    contentHash: await contentHash(input.url, input.title, input.folderPath),
    tags: input.tags ?? [],
  };
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function isTrackingParameter(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized.startsWith('utm_') || TRACKING_PARAMETERS.has(normalized);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
