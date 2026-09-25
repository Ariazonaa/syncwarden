import {
  createRemoteItem,
  UnsupportedBookmarkUrlError,
} from '../core/keys';
import { escapePathSegment } from '../core/paths';
import type { LocalItem, RemoteItem } from '../core/types';

const API_PREFIX = '/api/v1';
export const SYNC_TAG = 'browser-sync';
// Linkwarden's default top-level collection. The server has no real "no
// collection" state: a POST without collection puts links here, and a PUT
// always requires a collection object. We treat this collection as the
// bookmarks bar itself (empty canonical path).
export const DEFAULT_COLLECTION_NAME = 'Unorganized';
const REQUEST_TIMEOUT_MS = 25_000;

export interface LinkwardenConfig {
  baseUrl: string;
  token: string;
}

export interface LinkwardenCollection {
  id: number;
  name: string;
  ownerId?: number;
  parentId?: number | null;
}

export interface LinkwardenTag {
  id: number;
  name: string;
}

export interface LinkwardenLink {
  id: number;
  name: string | null;
  url: string;
  type?: string;
  description?: string | null;
  icon?: string | null;
  iconWeight?: string | null;
  color?: string | null;
  tags: LinkwardenTag[];
  collection?: LinkwardenCollection | null;
  pinnedBy?: Array<number | { id: number }>;
}

interface LinkwardenResponse<T> {
  response: T;
}

export interface CreateLinkInput {
  name: string;
  url: string;
  collection?: LinkwardenCollection;
}

export interface RemoteLinkRecord {
  item: RemoteItem;
  raw: LinkwardenLink;
}

export interface RemoteLinkPage {
  records: RemoteLinkRecord[];
  nextCursor: number | null;
  skippedCount: number;
  skippedIds: number[];
  unsafeSkippedIds: number[];
  unknownSkippedCount: number;
}

type FetchLike = typeof fetch;

export class LinkwardenHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: string,
  ) {
    super(toUserFacingHttpError(status, detail));
    this.name = 'LinkwardenHttpError';
  }
}

export class LinkwardenClient {
  private readonly baseUrl: string;

  constructor(
    private readonly config: LinkwardenConfig,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
  }

  async testConnection(): Promise<LinkwardenCollection[]> {
    const collections = await this.listCollections();
    await this.getCurrentUserId();
    return collections;
  }

  async getCurrentUserId(): Promise<number> {
    const payload = await this.request<unknown>('/users/me', { method: 'GET' });
    const user = unwrapResponse(payload);
    if (!isRecord(user) || !isNonNegativeInteger(user.id)) {
      throw unknownShapeError();
    }
    return user.id;
  }

  async listCollections(): Promise<LinkwardenCollection[]> {
    const payload = await this.request<unknown>('/collections', {
      method: 'GET',
    });
    const collections = unwrapResponse(payload);

    if (!Array.isArray(collections) || !collections.every(isCollection)) {
      throw unknownShapeError();
    }

    return collections;
  }

  async createCollection(
    name: string,
    parentId?: number | null,
  ): Promise<LinkwardenCollection> {
    const payload = await this.request<unknown>('/collections', {
      method: 'POST',
      body: JSON.stringify(
        parentId === undefined || parentId === null
          ? { name }
          : { name, parentId },
      ),
    });
    const collection = unwrapResponse(payload);

    if (!isCollection(collection)) {
      throw unknownShapeError();
    }

    return collection;
  }

  /**
   * Reads one page of links from the current search endpoint and falls back
   * to /links on older installs. The full collection path is resolved from
   * the parentId chain via collectionsById.
   */
  async listLinksPage(
    cursor: number | null,
    collectionsById: Map<number, LinkwardenCollection>,
    ownerId?: number,
  ): Promise<RemoteLinkPage> {
    const query = new URLSearchParams({ sort: '0' });
    if (cursor !== null) {
      query.set('cursor', String(cursor));
    }
    try {
      const payload = await this.request<unknown>(`/search?${query}`, {
        method: 'GET',
      });
      if (isSearchLinksResponse(payload)) {
        // The search endpoint returns the authoritative cursor, so pagination
        // stays complete even with a server-side page size.
        return mapRemotePage(
          payload.data.links,
          payload.data.nextCursor,
          collectionsById,
          ownerId,
        );
      }
    } catch (error) {
      if (!canFallbackToLegacyLinks(error)) {
        throw error;
      }
    }

    return this.listLegacyLinksPage(cursor, collectionsById, ownerId);
  }

  private async listLegacyLinksPage(
    cursor: number | null,
    collectionsById: Map<number, LinkwardenCollection>,
    ownerId?: number,
  ): Promise<RemoteLinkPage> {
    const query = new URLSearchParams({ sort: '0' });
    if (cursor !== null) {
      query.set('cursor', String(cursor));
    }
    const payload = await this.request<unknown>(`/links?${query}`, {
      method: 'GET',
    });
    const links = unwrapResponse(payload);
    if (!Array.isArray(links)) {
      throw unknownShapeError();
    }

    // The legacy endpoint has no nextCursor and a configurable page size, so
    // keep going until an empty page instead of assuming a fixed size (it
    // used to be 50).
    const lastId = lastNumericId(links);
    const nextCursor = links.length > 0 && lastId !== null ? lastId : null;
    return mapRemotePage(links, nextCursor, collectionsById, ownerId);
  }

  async createLink(input: CreateLinkInput): Promise<LinkwardenLink> {
    // Reference the collection as {id, ownerId} (same as the PUT) so Linkwarden
    // puts the link into the EXISTING collection. With only {id, name}, some
    // versions create a NEW collection by name -> duplicates. Without ownerId
    // the collection is ignored and the link ends up in "Unorganized".
    let collectionField: { id: number; ownerId: number } | undefined;
    if (input.collection !== undefined) {
      const ownerId = input.collection.ownerId;
      if (ownerId === undefined) {
        throw new Error(
          'Linkwarden did not return the collection owner. The link was not created.',
        );
      }
      collectionField = { id: input.collection.id, ownerId };
    }
    const payload = await this.request<unknown>('/links', {
      method: 'POST',
      body: JSON.stringify({
        name: input.name,
        url: input.url,
        tags: [{ name: SYNC_TAG }],
        ...(collectionField === undefined
          ? {}
          : { collection: collectionField }),
      }),
    });
    const link = unwrapResponse(payload);

    if (!isLink(link)) {
      throw new Error(
        'Linkwarden created the link but answered in an unknown format. Check the server version.',
      );
    }

    return link;
  }

  async updateLinkFromLocal(
    local: LocalItem,
    expectedRemote: RemoteItem,
    collection: LinkwardenCollection,
    collectionsById: Map<number, LinkwardenCollection>,
  ): Promise<LinkwardenLink> {
    const remoteId = expectedRemote.lwLinkId;
    const existing = await this.getLink(remoteId);
    await assertMatchingRemoteTarget(
      existing,
      expectedRemote,
      collectionsById,
      'update',
    );
    const tags = ensureSyncTag(existing.tags);
    // The server requires a collection object on PUT (neither null nor
    // leaving it out is accepted). The caller always passes a valid target
    // collection (top-level links -> "Unorganized").
    const ownerId = collection.ownerId;
    if (ownerId === undefined) {
      throw new Error(
        'Linkwarden did not return the collection owner. The update was not applied.',
      );
    }
    const collectionField = { id: collection.id, ownerId };
    const payload = await this.request<unknown>(`/links/${remoteId}`, {
      method: 'PUT',
      body: JSON.stringify({
        id: remoteId,
        name: local.title,
        url: local.url,
        description: existing.description ?? '',
        icon: existing.icon ?? null,
        iconWeight: existing.iconWeight ?? null,
        color: existing.color ?? null,
        collection: collectionField,
        tags,
        pinnedBy: normalizePinnedBy(existing.pinnedBy),
      }),
    });
    const updated = unwrapResponse(payload);

    if (!isLink(updated)) {
      throw unknownShapeError();
    }
    return updated;
  }

  /**
   * Adopts an existing link by adding the "browser-sync" tag WITHOUT changing
   * name, URL, collection or other tags. Used for links that were already
   * there or imported (e.g. via Floccus) and not created by Syncwarden.
   */
  async adoptLink(
    expectedRemote: RemoteItem,
    collectionsById: Map<number, LinkwardenCollection>,
  ): Promise<LinkwardenLink> {
    const remoteId = expectedRemote.lwLinkId;
    const existing = await this.getLink(remoteId);
    await assertMatchingRemoteTarget(
      existing,
      expectedRemote,
      collectionsById,
      'adoption',
    );
    const tags = ensureSyncTag(existing.tags);
    // The server requires a collection object on PUT. We must NOT change the
    // existing collection; if the link (in theory) has none, fall back to the
    // default "Unorganized" collection instead of sending a null the server
    // rejects.
    let collectionField: { id: number; ownerId: number };
    if (
      existing.collection === undefined ||
      existing.collection === null ||
      existing.collection.ownerId === undefined
    ) {
      const fallback = this.resolveDefaultCollection(collectionsById);
      collectionField = { id: fallback.id, ownerId: fallback.ownerId };
    } else {
      collectionField = {
        id: existing.collection.id,
        ownerId: existing.collection.ownerId,
      };
    }
    const payload = await this.request<unknown>(`/links/${remoteId}`, {
      method: 'PUT',
      body: JSON.stringify({
        id: remoteId,
        name: existing.name,
        url: existing.url,
        description: existing.description ?? '',
        icon: existing.icon ?? null,
        iconWeight: existing.iconWeight ?? null,
        color: existing.color ?? null,
        collection: collectionField,
        tags,
        pinnedBy: normalizePinnedBy(existing.pinnedBy),
      }),
    });
    const updated = unwrapResponse(payload);
    if (!isLink(updated)) {
      throw unknownShapeError();
    }
    return updated;
  }

  async getLink(id: number): Promise<LinkwardenLink> {
    const payload = await this.request<unknown>(`/links/${id}`, {
      method: 'GET',
    });
    const link = unwrapResponse(payload);
    if (!isLink(link)) {
      throw unknownShapeError();
    }
    return link;
  }

  async deleteLink(
    expectedRemote: RemoteItem,
    collectionsById: Map<number, LinkwardenCollection>,
  ): Promise<void> {
    const id = expectedRemote.lwLinkId;
    let existing: LinkwardenLink;
    try {
      existing = await this.getLink(id);
    } catch (error) {
      if (error instanceof LinkwardenHttpError && error.status === 404) {
        return;
      }
      throw error;
    }
    await assertMatchingRemoteTarget(
      existing,
      expectedRemote,
      collectionsById,
      'deletion',
    );
    await this.request<unknown>(`/links/${id}`, { method: 'DELETE' });
  }

  async assertLinkUnchanged(
    expectedRemote: RemoteItem,
    collectionsById: Map<number, LinkwardenCollection>,
  ): Promise<void> {
    const existing = await this.getLink(expectedRemote.lwLinkId);
    await assertMatchingRemoteTarget(
      existing,
      expectedRemote,
      collectionsById,
      'update',
    );
  }

  /**
   * Returns the default top-level "Unorganized" collection with a known
   * ownerId. Needed as a fallback when a link has no collection of its own
   * but the server insists on a collection object on PUT.
   */
  private resolveDefaultCollection(
    collectionsById: Map<number, LinkwardenCollection>,
  ): {
    id: number;
    ownerId: number;
  } {
    const match = [...collectionsById.values()].find(
      (collection) =>
        collection.name === DEFAULT_COLLECTION_NAME &&
        (collection.parentId ?? null) === null &&
        collection.ownerId !== undefined,
    );
    if (match?.ownerId === undefined) {
      throw new Error(
        'Default collection "Unorganized" not found. Adoption cancelled.',
      );
    }
    return { id: match.id, ownerId: match.ownerId };
  }

  private async request<T>(
    path: string,
    init: Pick<RequestInit, 'method' | 'body'>,
  ): Promise<T> {
    let response: Response;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      response = await this.fetchImpl(`${this.baseUrl}${API_PREFIX}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.config.token}`,
          ...(init.body === undefined
            ? {}
            : { 'Content-Type': 'application/json' }),
        },
      });
    } catch (error) {
      clearTimeout(timeoutId);
      if (controller.signal.aborted) {
        throw new Error(
          `Linkwarden did not answer within ${REQUEST_TIMEOUT_MS / 1_000} seconds. Sync cancelled.`,
        );
      }
      const detail = error instanceof Error ? error.message : 'network error';
      throw new Error(
        `Can't reach Linkwarden (${detail}). Check the base URL, host permission and server.`,
      );
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(
          `Linkwarden did not finish answering within ${REQUEST_TIMEOUT_MS / 1_000} seconds. Sync cancelled.`,
        );
      }
      const detail = error instanceof Error ? error.message : 'network error';
      throw new Error(
        `Could not read the Linkwarden response (${detail}).`,
      );
    } finally {
      clearTimeout(timeoutId);
    }
    const detail = extractErrorDetail(text);

    if (!response.ok) {
      throw new LinkwardenHttpError(response.status, detail);
    }

    if (text.length === 0) {
      throw new Error(
        'Linkwarden sent an empty response. Check the server version and reverse proxy.',
      );
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(
        'Linkwarden did not send valid JSON. Check the base URL and reverse proxy.',
      );
    }
  }
}

export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim();
  let url: URL;

  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(
      'The base URL is not valid. Use a full http or https address.',
    );
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('The base URL must start with https:// or http://.');
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      'The base URL must not contain credentials, query parameters or a fragment.',
    );
  }

  let pathname = url.pathname.replace(/\/+$/, '');
  if (pathname.endsWith(API_PREFIX)) {
    pathname = pathname.slice(0, -API_PREFIX.length);
  }

  return `${url.origin}${pathname}`.replace(/\/+$/, '');
}

export function permissionOrigin(baseUrl: string): string {
  return `${new URL(normalizeBaseUrl(baseUrl)).origin}/*`;
}

function unwrapResponse(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null) {
    return undefined;
  }
  return (payload as Partial<LinkwardenResponse<unknown>>).response;
}

function isSearchLinksResponse(
  value: unknown,
): value is { data: { links: unknown[]; nextCursor: number | null } } {
  if (!isRecord(value) || !isRecord(value.data)) {
    return false;
  }
  return (
    Array.isArray(value.data.links) &&
    (value.data.nextCursor === null ||
      isNonNegativeInteger(value.data.nextCursor))
  );
}

function canFallbackToLegacyLinks(error: unknown): boolean {
  return (
    error instanceof LinkwardenHttpError &&
    (error.status === 400 || error.status === 404)
  );
}

function lastNumericId(links: unknown[]): number | null {
  for (let index = links.length - 1; index >= 0; index -= 1) {
    const candidate = links[index];
    if (isRecord(candidate) && isNonNegativeInteger(candidate.id)) {
      return candidate.id;
    }
  }
  return null;
}

async function mapRemotePage(
  links: unknown[],
  nextCursor: number | null,
  collectionsById: Map<number, LinkwardenCollection>,
  ownerId?: number,
): Promise<RemoteLinkPage> {
  const records: RemoteLinkRecord[] = [];
  const skippedIds: number[] = [];
  const unsafeSkippedIds: number[] = [];
  let unknownSkippedCount = 0;

  for (const candidate of links) {
    const candidateId =
      isRecord(candidate) && isNonNegativeInteger(candidate.id)
        ? candidate.id
        : null;
    if (!isLink(candidate)) {
      if (candidateId === null) {
        unknownSkippedCount += 1;
      } else {
        skippedIds.push(candidateId);
        unsafeSkippedIds.push(candidateId);
      }
      continue;
    }
    if (candidate.type === 'pdf' || candidate.type === 'image') {
      skippedIds.push(candidate.id);
      continue;
    }
    if (ownerId !== undefined && candidate.collection != null) {
      const fullCollection = collectionsById.get(candidate.collection.id);
      if (fullCollection?.ownerId === undefined) {
        skippedIds.push(candidate.id);
        unsafeSkippedIds.push(candidate.id);
        continue;
      }
      if (fullCollection.ownerId !== ownerId) {
        // Shared collections owned by someone else are left alone on purpose.
        skippedIds.push(candidate.id);
        continue;
      }
    }

    try {
      const item = await createRemoteItem({
        lwLinkId: candidate.id,
        url: candidate.url,
        title: candidate.name ?? candidate.url,
        folderPath: collectionFullPath(candidate.collection, collectionsById),
        tags: candidate.tags.map((tag) => tag.name),
      });
      records.push({ item, raw: candidate });
    } catch (error) {
      if (error instanceof UnsupportedBookmarkUrlError) {
        skippedIds.push(candidate.id);
        continue;
      }
      throw error;
    }
  }

  return {
    records,
    nextCursor,
    skippedCount: skippedIds.length + unknownSkippedCount,
    skippedIds,
    unsafeSkippedIds,
    unknownSkippedCount,
  };
}

/**
 * Builds the full nested path of a collection from its parentId chain
 * (e.g. "Work/Projects/2026"). Segments are escaped like in paths.ts so a "/"
 * inside a collection name doesn't change the depth. Cycles and missing
 * parents abort the scan before it can cause wrong moves.
 */
function collectionFullPath(
  collection: LinkwardenCollection | null | undefined,
  byId: Map<number, LinkwardenCollection>,
): string {
  if (collection === undefined || collection === null) {
    return '';
  }
  const segments: string[] = [];
  const seen = new Set<number>();
  let current: LinkwardenCollection | undefined = byId.get(collection.id);
  if (current === undefined) {
    throw new Error(
      `Linkwarden collection ${collection.id} is missing from the inventory. Sync cancelled.`,
    );
  }
  while (current !== undefined) {
    if (seen.has(current.id)) {
      throw new Error(
        'The Linkwarden collection hierarchy contains a cycle. Sync cancelled.',
      );
    }
    seen.add(current.id);
    // The top-level "Unorganized" collection is the bookmarks bar itself ->
    // empty canonical path. That way a link at the top of the bar (it lands
    // in "Unorganized" after upload) maps back to the bar when read again and
    // isn't updated over and over.
    if (
      (current.parentId ?? null) === null &&
      current.name === DEFAULT_COLLECTION_NAME
    ) {
      break;
    }
    segments.unshift(escapePathSegment(current.name));
    const parentId: number | null | undefined = current.parentId;
    if (parentId === undefined || parentId === null) {
      current = undefined;
    } else {
      current = byId.get(parentId);
      if (current === undefined) {
        throw new Error(
          `Parent Linkwarden collection ${parentId} is missing. Sync cancelled.`,
        );
      }
    }
  }
  return segments.join('/');
}

function isCollection(value: unknown): value is LinkwardenCollection {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isNonNegativeInteger(value.id) &&
    typeof value.name === 'string' &&
    (value.ownerId === undefined || isNonNegativeInteger(value.ownerId)) &&
    (value.parentId === undefined ||
      value.parentId === null ||
      isNonNegativeInteger(value.parentId))
  );
}

function isTag(value: unknown): value is LinkwardenTag {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.id) &&
    typeof value.name === 'string'
  );
}

function isLink(value: unknown): value is LinkwardenLink {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isNonNegativeInteger(value.id) &&
    (typeof value.name === 'string' || value.name === null) &&
    typeof value.url === 'string' &&
    Array.isArray(value.tags) &&
    value.tags.every(isTag) &&
    (value.collection === undefined ||
      value.collection === null ||
      isCollection(value.collection))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function ensureSyncTag(tags: LinkwardenTag[]): Array<{ id?: number; name: string }> {
  const result: Array<{ id?: number; name: string }> = tags.map((tag) => ({
    id: tag.id,
    name: tag.name,
  }));
  if (!result.some((tag) => tag.name === SYNC_TAG)) {
    result.push({ name: SYNC_TAG });
  }
  return result;
}

function normalizePinnedBy(
  pinnedBy: LinkwardenLink['pinnedBy'],
): Array<{ id: number }> {
  return (pinnedBy ?? []).flatMap((entry) => {
    const id = typeof entry === 'number' ? entry : entry.id;
    return Number.isFinite(id) ? [{ id }] : [];
  });
}

async function assertMatchingRemoteTarget(
  link: LinkwardenLink,
  expected: RemoteItem,
  collectionsById: Map<number, LinkwardenCollection>,
  operation: 'update' | 'adoption' | 'deletion',
): Promise<void> {
  let current: RemoteItem;
  try {
    current = await createRemoteItem({
      lwLinkId: link.id,
      url: link.url,
      title: link.name ?? link.url,
      folderPath: collectionFullPath(link.collection, collectionsById),
      tags: link.tags.map((tag) => tag.name),
    });
  } catch {
    throw new Error(
      `The remote link can no longer be matched safely to the planned ${operation}.`,
    );
  }
  if (
    current.stableKey !== expected.stableKey ||
    current.contentHash !== expected.contentHash
  ) {
    throw new Error(
      `The remote link changed since the plan was made; ${operation} cancelled.`,
    );
  }
}

function unknownShapeError(): Error {
  return new Error(
    'Linkwarden answered in an unknown format. Check the server version and API path.',
  );
}

function extractErrorDetail(text: string): string {
  if (text.length === 0) {
    return 'no error details';
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && typeof parsed.response === 'string') {
      return parsed.response;
    }
  } catch {
    // The HTTP status stays the authoritative error.
  }
  return text.slice(0, 240);
}

function toUserFacingHttpError(status: number, detail: string): string {
  switch (status) {
    case 401:
      return 'Token rejected (401). Check the access token in the Linkwarden settings.';
    case 403:
      return 'Access denied (403). Check the access token’s permissions.';
    case 404:
      return 'Linkwarden API not found (404). Check the base URL and server version.';
    default:
      return `Linkwarden returned HTTP ${status} (${detail}). Check the server and reverse proxy.`;
  }
}
