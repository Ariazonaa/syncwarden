import type { LinkwardenLink } from './linkwarden';
import type { SyncState } from '../core/types';
import { recoverSyncState } from '../core/types';

const SNAPSHOTS_KEY = 'syncSnapshots';
// chrome.storage.local is limited to 5 MB. Snapshots hold the full bookmark
// tree plus a slimmed-down remote copy; a few are enough to diagnose and
// restore. A low limit keeps quota use small.
const SNAPSHOT_LIMIT = 3;
const EDITABLE_ROOT_LIMIT = 3;

/**
 * Minimal copy of a remote link for snapshots. `remoteBefore` is NOT read on
 * restore (only `localTree` + `state`), it is only there for diagnosis. So we
 * keep the identifying fields instead of full Linkwarden records to save
 * storage.
 */
export interface RemoteLinkSnapshot {
  id: number;
  url: string;
  name: string | null;
  collectionId: number | null;
  collectionName: string | null;
  tags: string[];
}

export interface SyncSnapshot {
  id: string;
  createdAt: number;
  reason: string;
  localTree: chrome.bookmarks.BookmarkTreeNode[];
  remoteBefore: RemoteLinkSnapshot[];
  state: SyncState;
}

function slimRemoteLink(link: LinkwardenLink): RemoteLinkSnapshot {
  return {
    id: link.id,
    url: link.url,
    name: link.name,
    collectionId: link.collection?.id ?? null,
    collectionName: link.collection?.name ?? null,
    tags: (link.tags ?? []).map((tag) => tag.name),
  };
}

export async function createSnapshot(input: {
  reason: string;
  remoteBefore: LinkwardenLink[];
  state: SyncState;
  now?: number;
}): Promise<SyncSnapshot> {
  const localTree = await chrome.bookmarks.getTree();
  const snapshot: SyncSnapshot = {
    id: crypto.randomUUID(),
    createdAt: input.now ?? Date.now(),
    reason: input.reason,
    localTree,
    remoteBefore: input.remoteBefore.map(slimRemoteLink),
    state: input.state,
  };
  const current = await listSnapshots();
  await chrome.storage.local.set({
    [SNAPSHOTS_KEY]: [snapshot, ...current]
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, SNAPSHOT_LIMIT),
  });
  return snapshot;
}

export async function listSnapshots(): Promise<SyncSnapshot[]> {
  const stored = await chrome.storage.local.get(SNAPSHOTS_KEY);
  const value: unknown = stored[SNAPSHOTS_KEY];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isSyncSnapshot).slice(0, SNAPSHOT_LIMIT);
}

export async function getSnapshot(id: string): Promise<SyncSnapshot | null> {
  return (await listSnapshots()).find((snapshot) => snapshot.id === id) ?? null;
}

/**
 * Rebuilds the local bookmark tree from a snapshot. Existing bookmarks and
 * folders under the editable roots are removed, then the captured tree is
 * recreated node for node. Restore runs inside the caller-provided write mutex
 * so it never triggers a sync loop (I6). Remote state is intentionally left
 * untouched; the snapshot's SyncState is restored so the next sync reconciles.
 */
export async function restoreLocalTree(
  snapshot: SyncSnapshot,
  api: {
    getTree(): Promise<chrome.bookmarks.BookmarkTreeNode[]>;
    create(
      details: chrome.bookmarks.CreateDetails,
    ): Promise<chrome.bookmarks.BookmarkTreeNode>;
    removeTree(id: string): Promise<void>;
    remove(id: string): Promise<void>;
  } = chrome.bookmarks,
): Promise<void> {
  const currentTree = await api.getTree();
  const currentRoot = currentTree[0];
  const snapshotRoot = snapshot.localTree[0];
  if (currentRoot === undefined || snapshotRoot === undefined) {
    throw new Error('Snapshot or current tree is empty. Restore cancelled.');
  }

  const currentRoots = (currentRoot.children ?? []).slice(
    0,
    EDITABLE_ROOT_LIMIT,
  );
  const snapshotRoots = (snapshotRoot.children ?? []).slice(
    0,
    EDITABLE_ROOT_LIMIT,
  );

  if (currentRoots.length !== snapshotRoots.length) {
    throw new Error(
      'The browser root folders don’t match the snapshot. Restore cancelled before anything was changed.',
    );
  }
  for (let index = 0; index < currentRoots.length; index += 1) {
    const liveRoot = currentRoots[index];
    const savedRoot = snapshotRoots[index];
    if (
      liveRoot === undefined ||
      savedRoot === undefined ||
      liveRoot.title !== savedRoot.title
    ) {
      throw new Error(
        'The browser root folders don’t match the snapshot. Restore cancelled before anything was changed.',
      );
    }
  }

  for (let index = 0; index < currentRoots.length; index += 1) {
    const liveRoot = currentRoots[index];
    const savedRoot = snapshotRoots[index];
    if (liveRoot === undefined || savedRoot === undefined) {
      continue;
    }
    for (const child of liveRoot.children ?? []) {
      if (child.url === undefined) {
        await api.removeTree(child.id);
      } else {
        await api.remove(child.id);
      }
    }
    for (const child of savedRoot.children ?? []) {
      await recreateNode(api, liveRoot.id, child);
    }
  }
}

async function recreateNode(
  api: {
    create(
      details: chrome.bookmarks.CreateDetails,
    ): Promise<chrome.bookmarks.BookmarkTreeNode>;
  },
  parentId: string,
  node: chrome.bookmarks.BookmarkTreeNode,
): Promise<void> {
  if (node.url !== undefined) {
    await api.create({ parentId, title: node.title, url: node.url });
    return;
  }
  const folder = await api.create({ parentId, title: node.title });
  for (const child of node.children ?? []) {
    await recreateNode(api, folder.id, child);
  }
}

function isSyncSnapshot(value: unknown): value is SyncSnapshot {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === 'string' &&
    typeof value.createdAt === 'number' &&
    Number.isFinite(value.createdAt) &&
    typeof value.reason === 'string' &&
    Array.isArray(value.localTree) &&
    value.localTree.length === 1 &&
    value.localTree.every(isBookmarkTreeNode) &&
    isValidSnapshotRoot(value.localTree[0]) &&
    Array.isArray(value.remoteBefore) &&
    value.remoteBefore.every(isRemoteLinkSnapshot) &&
    !recoverSyncState(value.state).recoveredFromCorruption
  );
}

function isValidSnapshotRoot(value: unknown): boolean {
  if (
    !isRecord(value) ||
    value.url !== undefined ||
    !Array.isArray(value.children)
  ) {
    return false;
  }
  const editableRoots = value.children.slice(0, EDITABLE_ROOT_LIMIT);
  return (
    editableRoots.length > 0 &&
    editableRoots.every(
      (root) =>
        isRecord(root) &&
        root.url === undefined &&
        Array.isArray(root.children),
    )
  );
}

function isBookmarkTreeNode(
  value: unknown,
): value is chrome.bookmarks.BookmarkTreeNode {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.id !== 'string' || typeof value.title !== 'string') {
    return false;
  }
  if (typeof value.url === 'string') {
    return value.children === undefined;
  }
  return (
    value.url === undefined &&
    Array.isArray(value.children) &&
    value.children.every(isBookmarkTreeNode)
  );
}

function isRemoteLinkSnapshot(value: unknown): value is RemoteLinkSnapshot {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === 'number' &&
    Number.isInteger(value.id) &&
    value.id >= 0 &&
    typeof value.url === 'string' &&
    (typeof value.name === 'string' || value.name === null) &&
    (typeof value.collectionId === 'number' || value.collectionId === null) &&
    (typeof value.collectionName === 'string' ||
      value.collectionName === null) &&
    Array.isArray(value.tags) &&
    value.tags.every((tag) => typeof tag === 'string')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
