import { applyDeletionBrake } from './plan';
import type {
  LocalItem,
  PlanNotice,
  RemoteItem,
  StableKey,
  StateUpsert,
  SyncAction,
  SyncMode,
  SyncPlan,
  SyncState,
  SyncedItem,
} from './types';

const SYNC_TAG = 'browser-sync';

export function buildPlan(
  local: LocalItem[],
  remote: RemoteItem[],
  state: SyncState,
  mode: SyncMode,
  now: number,
): SyncPlan {
  const notices: PlanNotice[] = [];
  const localByKey = canonicalizeLocal(local, state, notices);
  const remoteByKey = canonicalizeRemote(remote, state, notices);
  const duplicateLocalKeys = duplicateKeys(notices, 'duplicate-local');
  const duplicateRemoteKeys = duplicateKeys(notices, 'duplicate-remote');
  const actions: SyncAction[] = [];
  const upsert: Record<StableKey, StateUpsert> = {};
  const remove = new Set<StableKey>();
  const initialConflicts: StableKey[] = [];
  const allKeys = new Set([
    ...localByKey.keys(),
    ...remoteByKey.keys(),
    ...Object.keys(state.items),
  ]);

  for (const key of [...allKeys].sort(compareText)) {
    const localItem = localByKey.get(key);
    const remoteItem = remoteByKey.get(key);
    const syncedItem = state.items[key];

    if (syncedItem === undefined) {
      if (localItem !== undefined && remoteItem === undefined) {
        actions.push(createRemote(localItem, 'new:local'));
        upsert[key] = afterAction(fromLocal(localItem, null, now));
      } else if (localItem === undefined && remoteItem !== undefined) {
        if (mode !== 'additive-up') {
          actions.push(createLocal(remoteItem, 'new:remote'));
          upsert[key] = afterAction(fromRemote(remoteItem, null, now));
        }
      } else if (localItem !== undefined && remoteItem !== undefined) {
        if (localItem.contentHash === remoteItem.contentHash) {
          // First sync, same content: adopt an existing/imported link that
          // lacks the sync tag, otherwise just merge the state.
          if (!remoteItem.tags.includes(SYNC_TAG)) {
            actions.push(
              adoptRemote(localItem, remoteItem, 'adopt:missing-tag'),
            );
            upsert[key] = afterAction(
              fromBoth(localItem, remoteItem, localItem, now),
            );
          } else {
            upsert[key] = immediate(
              fromBoth(localItem, remoteItem, localItem, now),
            );
          }
        } else {
          actions.push(
            updateRemote(localItem, remoteItem, 'conflict:initial-local-wins'),
          );
          upsert[key] = afterAction(
            fromBoth(localItem, remoteItem, localItem, now),
          );
          initialConflicts.push(key);
        }
      }
      continue;
    }

    if (localItem === undefined && remoteItem === undefined) {
      remove.add(key);
      continue;
    }

    if (localItem !== undefined && remoteItem === undefined) {
      if (mode === 'bidirectional') {
        if (duplicateLocalKeys.has(key)) {
          continue;
        }
        actions.push(deleteLocal(localItem, 'deleted:remote'));
        remove.add(key);
      } else {
        actions.push(createRemote(localItem, 'missing:remote-recreate'));
        upsert[key] = afterAction(fromLocal(localItem, null, now));
      }
      continue;
    }

    if (localItem === undefined && remoteItem !== undefined) {
      if (mode === 'additive-both') {
        actions.push(createLocal(remoteItem, 'missing:local-recreate'));
        upsert[key] = afterAction(fromRemote(remoteItem, null, now));
      } else if (mode === 'bidirectional') {
        if (duplicateRemoteKeys.has(key)) {
          continue;
        }
        // Being in the SyncState is what proves ownership: only links that
        // were synced before get here. The browser-sync tag can be missing on
        // older installs, imports or after an edit in Linkwarden, so it must
        // not swallow a deletion the user made locally.
        actions.push(deleteRemote(remoteItem, 'deleted:local'));
        remove.add(key);
      }
      continue;
    }

    if (localItem === undefined || remoteItem === undefined) {
      continue;
    }

    if (localItem.contentHash === remoteItem.contentHash) {
      // Same content: normally a no-op. But if the remote link lacks the sync
      // tag (existing or imported link, e.g. via Floccus), we adopt it. That
      // only adds the tag, no metadata change and no deletion.
      if (!remoteItem.tags.includes(SYNC_TAG)) {
        actions.push(adoptRemote(localItem, remoteItem, 'adopt:missing-tag'));
        upsert[key] = afterAction(
          fromBoth(localItem, remoteItem, localItem, now),
        );
      } else {
        upsert[key] = immediate(
          fromBoth(localItem, remoteItem, localItem, now),
        );
      }
      continue;
    }

    if (mode === 'additive-up') {
      const reason =
        localItem.contentHash !== syncedItem.contentHash &&
        remoteItem.contentHash !== syncedItem.contentHash
          ? 'conflict:local-wins'
          : 'source:local';
      actions.push(updateRemote(localItem, remoteItem, reason));
      upsert[key] = afterAction(fromBoth(localItem, remoteItem, localItem, now));
      continue;
    }

    const localChanged = localItem.contentHash !== syncedItem.contentHash;
    const remoteChanged = remoteItem.contentHash !== syncedItem.contentHash;

    if (localChanged && !remoteChanged) {
      actions.push(updateRemote(localItem, remoteItem, 'changed:local'));
      upsert[key] = afterAction(fromBoth(localItem, remoteItem, localItem, now));
    } else if (!localChanged && remoteChanged) {
      actions.push(updateLocal(localItem, remoteItem, 'changed:remote'));
      upsert[key] = afterAction(
        fromBoth(localItem, remoteItem, remoteItem, now),
      );
    } else {
      actions.push(
        updateRemote(localItem, remoteItem, 'conflict:local-wins'),
      );
      upsert[key] = afterAction(fromBoth(localItem, remoteItem, localItem, now));
    }
  }

  const stateDelta = { upsert, remove: [...remove].sort(compareText) };
  const basePlan: SyncPlan =
    initialConflicts.length === 0
      ? {
          actions,
          stateDelta,
          notices,
          deletionCount: 0,
          blocked: false,
        }
      : {
          actions,
          stateDelta,
          notices,
          deletionCount: 0,
          blocked: true,
          blockReason:
            `First sync held back: ${initialConflicts.length} URL keys ` +
            'have different metadata locally and remotely.',
        };

  return applyDeletionBrake(basePlan, Object.keys(state.items).length);
}

function duplicateKeys(
  notices: PlanNotice[],
  type: PlanNotice['type'],
): Set<StableKey> {
  return new Set(
    notices
      .filter((notice) => notice.type === type)
      .map((notice) => notice.stableKey),
  );
}

function canonicalizeLocal(
  items: LocalItem[],
  state: SyncState,
  notices: PlanNotice[],
): Map<StableKey, LocalItem> {
  return canonicalize(
    items,
    state,
    notices,
    'duplicate-local',
    'Several local bookmarks have the same normalized URL.',
  );
}

function canonicalizeRemote(
  items: RemoteItem[],
  state: SyncState,
  notices: PlanNotice[],
): Map<StableKey, RemoteItem> {
  return canonicalize(
    items,
    state,
    notices,
    'duplicate-remote',
    'Several remote links have the same normalized URL.',
  );
}

function canonicalize<T extends LocalItem | RemoteItem>(
  items: T[],
  state: SyncState,
  notices: PlanNotice[],
  noticeType: 'duplicate-local' | 'duplicate-remote',
  message: string,
): Map<StableKey, T> {
  const grouped = new Map<StableKey, T[]>();
  for (const item of items) {
    const entries = grouped.get(item.stableKey) ?? [];
    entries.push(item);
    grouped.set(item.stableKey, entries);
  }

  const result = new Map<StableKey, T>();
  for (const [key, entries] of grouped) {
    const previousHash = state.items[key]?.contentHash;
    const sorted = [...entries].sort((left, right) => {
      const leftMatches = left.contentHash === previousHash ? 0 : 1;
      const rightMatches = right.contentHash === previousHash ? 0 : 1;
      if (leftMatches !== rightMatches) {
        return leftMatches - rightMatches;
      }
      return compareText(
        `${left.folderPath}\u0000${left.title}`,
        `${right.folderPath}\u0000${right.title}`,
      );
    });
    const canonical = sorted[0];
    if (canonical !== undefined) {
      result.set(key, canonical);
    }
    if (entries.length > 1) {
      notices.push({ type: noticeType, stableKey: key, message });
    }
  }
  return result;
}

function fromLocal(
  local: LocalItem,
  lwLinkId: number | null,
  now: number,
): SyncedItem {
  return {
    stableKey: local.stableKey,
    chromeId: local.chromeId,
    lwLinkId,
    url: local.url,
    title: local.title,
    folderPath: local.folderPath,
    contentHash: local.contentHash,
    lastSyncedAt: now,
  };
}

function fromRemote(
  remote: RemoteItem,
  chromeId: string | null,
  now: number,
): SyncedItem {
  return {
    stableKey: remote.stableKey,
    chromeId,
    lwLinkId: remote.lwLinkId,
    url: remote.url,
    title: remote.title,
    folderPath: remote.folderPath,
    contentHash: remote.contentHash,
    lastSyncedAt: now,
  };
}

function fromBoth(
  local: LocalItem,
  remote: RemoteItem,
  winner: LocalItem | RemoteItem,
  now: number,
): SyncedItem {
  return {
    stableKey: winner.stableKey,
    chromeId: local.chromeId,
    lwLinkId: remote.lwLinkId,
    url: winner.url,
    title: winner.title,
    folderPath: winner.folderPath,
    contentHash: winner.contentHash,
    lastSyncedAt: now,
  };
}

function immediate(item: SyncedItem): StateUpsert {
  return { item, commit: 'immediate' };
}

function afterAction(item: SyncedItem): StateUpsert {
  return { item, commit: 'after-action' };
}

function createRemote(local: LocalItem, reason: string): SyncAction {
  return {
    type: 'createRemote',
    stableKey: local.stableKey,
    reason,
    payload: { local },
  };
}

function createLocal(remote: RemoteItem, reason: string): SyncAction {
  return {
    type: 'createLocal',
    stableKey: remote.stableKey,
    reason,
    payload: { remote },
  };
}

function updateRemote(
  local: LocalItem,
  remote: RemoteItem,
  reason: string,
): SyncAction {
  return {
    type: 'updateRemote',
    stableKey: local.stableKey,
    reason,
    payload: { local, remote },
  };
}

function updateLocal(
  local: LocalItem,
  remote: RemoteItem,
  reason: string,
): SyncAction {
  return {
    type: 'updateLocal',
    stableKey: local.stableKey,
    reason,
    payload: { local, remote },
  };
}

function deleteRemote(remote: RemoteItem, reason: string): SyncAction {
  return {
    type: 'deleteRemote',
    stableKey: remote.stableKey,
    reason,
    payload: { remote },
  };
}

function adoptRemote(
  local: LocalItem,
  remote: RemoteItem,
  reason: string,
): SyncAction {
  return {
    type: 'adoptRemote',
    stableKey: local.stableKey,
    reason,
    payload: { local, remote },
  };
}

function deleteLocal(local: LocalItem, reason: string): SyncAction {
  return {
    type: 'deleteLocal',
    stableKey: local.stableKey,
    reason,
    payload: { local },
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
