import {
  createLocalItem,
  UnsupportedBookmarkUrlError,
} from '../core/keys';
import {
  BOOKMARK_ROOT_PATHS,
  escapePathSegment,
  localMirrorPathToRemotePath,
  normalizeFolderPath,
  unescapePathSegment,
  type BookmarkRoot,
} from '../core/paths';
import type { FolderPath, LocalItem, StableKey } from '../core/types';

export interface SkippedBookmark {
  chromeId: string;
  title: string;
  reason: string;
}

export interface BookmarkInventory {
  items: LocalItem[];
  skipped: SkippedBookmark[];
  tree: chrome.bookmarks.BookmarkTreeNode[];
}

export interface BookmarkApi {
  getTree(): Promise<chrome.bookmarks.BookmarkTreeNode[]>;
  create(
    bookmark: chrome.bookmarks.CreateDetails,
  ): Promise<chrome.bookmarks.BookmarkTreeNode>;
  update(
    id: string,
    changes: chrome.bookmarks.UpdateChanges,
  ): Promise<chrome.bookmarks.BookmarkTreeNode>;
  move(
    id: string,
    destination: chrome.bookmarks.MoveDestination,
  ): Promise<chrome.bookmarks.BookmarkTreeNode>;
  remove(id: string): Promise<void>;
  removeTree(id: string): Promise<void>;
}

export class ChromeBookmarksAdapter {
  constructor(private readonly api: BookmarkApi = chrome.bookmarks) {}

  async readInventory(): Promise<BookmarkInventory> {
    const tree = await this.api.getTree();
    const root = tree[0];
    if (root === undefined) {
      return { items: [], skipped: [], tree };
    }

    const items: LocalItem[] = [];
    const skipped: SkippedBookmark[] = [];
    const rootEntries = editableRoots(root);
    for (const entry of rootEntries) {
      await this.walk(entry.node, BOOKMARK_ROOT_PATHS[entry.root], items, skipped);
    }
    return { items, skipped, tree };
  }

  async createBookmark(input: {
    url: string;
    title: string;
    folderPath: FolderPath;
  }): Promise<chrome.bookmarks.BookmarkTreeNode> {
    const parentId = await this.resolveOrCreateFolder(input.folderPath);
    return this.api.create({ parentId, title: input.title, url: input.url });
  }

  async updateBookmark(
    chromeId: string,
    stableKey: StableKey,
    input: { url: string; title: string; folderPath: FolderPath },
    expectedContentHash?: string,
  ): Promise<chrome.bookmarks.BookmarkTreeNode> {
    const inventory = await this.readInventory();
    const target = inventory.items.find((item) => item.chromeId === chromeId);
    if (target === undefined) {
      if (findTreeNode(inventory.tree, chromeId) !== undefined) {
        throw new Error(
          'The local bookmark can no longer be matched safely to the planned update.',
        );
      }
      throw new Error('Local bookmark for the update not found.');
    }
    assertMatchingLocalTarget(
      target,
      stableKey,
      expectedContentHash,
      'update',
    );
    const updated = await this.api.update(chromeId, {
      title: input.title,
      url: input.url,
    });
    const parentId = await this.resolveOrCreateFolder(input.folderPath);
    if (updated.parentId !== parentId) {
      return this.api.move(updated.id, { parentId });
    }
    return updated;
  }

  async deleteBookmark(
    chromeId: string,
    stableKey: StableKey,
    expectedContentHash?: string,
  ): Promise<void> {
    const inventory = await this.readInventory();
    const target = inventory.items.find((item) => item.chromeId === chromeId);
    if (target === undefined) {
      if (findTreeNode(inventory.tree, chromeId) !== undefined) {
        throw new Error(
          'The local bookmark can no longer be matched safely to the planned deletion.',
        );
      }
      return;
    }
    assertMatchingLocalTarget(
      target,
      stableKey,
      expectedContentHash,
      'deletion',
    );
    await this.api.remove(chromeId);
  }

  async assertBookmarkUnchanged(expected: LocalItem): Promise<void> {
    const inventory = await this.readInventory();
    const target = inventory.items.find(
      (item) => item.chromeId === expected.chromeId,
    );
    if (target === undefined) {
      throw new Error(
        'The local bookmark was removed since the plan was made or can no longer be synced.',
      );
    }
    assertMatchingLocalTarget(
      target,
      expected.stableKey,
      expected.contentHash,
      'update',
    );
  }

  private async walk(
    node: chrome.bookmarks.BookmarkTreeNode,
    folderPath: FolderPath,
    items: LocalItem[],
    skipped: SkippedBookmark[],
  ): Promise<void> {
    for (const child of node.children ?? []) {
      if (child.url === undefined) {
        const childPath = `${folderPath}/${escapePathSegment(child.title)}`;
        await this.walk(child, childPath, items, skipped);
        continue;
      }

      try {
        items.push(
          await createLocalItem({
            chromeId: child.id,
            url: child.url,
            title: child.title || child.url,
            folderPath: canonicalFolderPath(folderPath),
          }),
        );
      } catch (error) {
        if (error instanceof UnsupportedBookmarkUrlError) {
          skipped.push({
            chromeId: child.id,
            title: child.title,
            reason: error.message,
          });
          continue;
        }
        throw error;
      }
    }
  }

  private async resolveOrCreateFolder(folderPath: FolderPath): Promise<string> {
    const normalized = normalizeFolderPath(folderPath);
    const segments = normalized.split('/');
    const rootName = segments.shift();
    const rootKey = rootKeyFromPath(rootName);
    if (rootKey === null) {
      throw new Error(`Unknown bookmark root: ${rootName ?? ''}`);
    }

    const tree = await this.api.getTree();
    const root = tree[0];
    if (root === undefined) {
      throw new Error('The browser bookmark tree is empty.');
    }
    const rootNode = editableRoots(root).find((entry) => entry.root === rootKey)?.node;
    if (rootNode === undefined) {
      throw new Error(`Bookmark root missing: ${BOOKMARK_ROOT_PATHS[rootKey]}`);
    }

    let parent = rootNode;
    for (const encoded of segments) {
      const title = unescapePathSegment(encoded);
      const existing = (parent.children ?? []).find(
        (child) => child.url === undefined && child.title === title,
      );
      parent =
        existing ??
        (await this.api.create({ parentId: parent.id, title }));
      if (parent.children === undefined) {
        parent.children = [];
      }
    }
    return parent.id;
  }
}

interface RootEntry {
  root: BookmarkRoot;
  node: chrome.bookmarks.BookmarkTreeNode;
}

function editableRoots(root: chrome.bookmarks.BookmarkTreeNode): RootEntry[] {
  const children = root.children ?? [];
  const roots: BookmarkRoot[] = ['bar', 'other', 'mobile'];
  return roots.flatMap((rootName, index) => {
    const node = children[index];
    return node === undefined ? [] : [{ root: rootName, node }];
  });
}

function rootKeyFromPath(value: string | undefined): BookmarkRoot | null {
  for (const [key, path] of Object.entries(BOOKMARK_ROOT_PATHS)) {
    if (path === value) {
      return key as BookmarkRoot;
    }
  }
  return null;
}

/**
 * Bookmarks living under the Linkwarden mirror root are reported in
 * remote-collection space (e.g. "Dev/Rust", "" for the mirror root itself),
 * so downloaded items round-trip against their originating collection without
 * spurious updates. Native bookmarks keep their local logical path, which is
 * also the collection name they upload into.
 */
function canonicalFolderPath(localFolderPath: FolderPath): FolderPath {
  return localMirrorPathToRemotePath(localFolderPath) ?? localFolderPath;
}

function assertMatchingLocalTarget(
  item: LocalItem,
  expectedStableKey: StableKey,
  expectedContentHash: string | undefined,
  operation: 'update' | 'deletion',
): void {
  if (
    item.stableKey !== expectedStableKey ||
    (expectedContentHash !== undefined &&
      item.contentHash !== expectedContentHash)
  ) {
    throw new Error(
      `The local bookmark changed since the plan was made; ${operation} cancelled.`,
    );
  }
}

function findTreeNode(
  tree: chrome.bookmarks.BookmarkTreeNode[],
  chromeId: string,
): chrome.bookmarks.BookmarkTreeNode | undefined {
  for (const node of tree) {
    if (node.id === chromeId) {
      return node;
    }
    const nested = findTreeNode(node.children ?? [], chromeId);
    if (nested !== undefined) {
      return nested;
    }
  }
  return undefined;
}

const WRITE_GUARD_KEY = 'bookmarkWriteGuard';
// Chrome sometimes fires bookmarks.onCreated/onChanged/... shortly AFTER the
// write API has resolved. If we removed the guard right away in finally, the
// onChanged listener would see our own event as a user change and start a
// pointless sync. So the guard lingers a little to swallow those late events.
// The stale timeout (60s) still covers crashes.
const WRITE_GUARD_LINGER_MS = 750;
let mutexTail: Promise<void> = Promise.resolve();

export async function withBookmarkWriteMutex<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const previous = mutexTail;
  let release: () => void = () => undefined;
  mutexTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  const guard = { id: crypto.randomUUID(), startedAt: Date.now() };
  let guardWritten = false;
  try {
    await chrome.storage.local.set({ [WRITE_GUARD_KEY]: guard });
    guardWritten = true;
    return await operation();
  } finally {
    // Release the mutex right away so the next write can start, and do NOT
    // make the caller wait for the lingering guard.
    release();
    // Clear the guard later and detached, so late Chrome events are still
    // swallowed. Errors here don't matter; the stale timeout (60s) in
    // isBookmarkWriteGuardActive cleans up if needed.
    if (guardWritten) {
      void lingerClearGuard(guard.id);
    }
  }
}

async function lingerClearGuard(guardId: string): Promise<void> {
  try {
    await delay(WRITE_GUARD_LINGER_MS);
    const stored = await chrome.storage.local.get(WRITE_GUARD_KEY);
    const current: unknown = stored[WRITE_GUARD_KEY];
    // Only remove it if no later write has replaced the guard with a new id
    // (we must not remove that write's protection).
    if (isRecord(current) && current.id === guardId) {
      await chrome.storage.local.remove(WRITE_GUARD_KEY);
    }
  } catch {
    // ignored on purpose; the stale timeout is the safety net.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function isBookmarkWriteGuardActive(): Promise<boolean> {
  const stored = await chrome.storage.local.get(WRITE_GUARD_KEY);
  const value: unknown = stored[WRITE_GUARD_KEY];
  if (!isRecord(value) || typeof value.startedAt !== 'number') {
    return false;
  }
  const stale = Date.now() - value.startedAt > 60_000;
  if (stale) {
    await chrome.storage.local.remove(WRITE_GUARD_KEY);
    return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
