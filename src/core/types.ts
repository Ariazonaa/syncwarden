export type StableKey = string;
export type FolderPath = string;
export type SyncMode = 'additive-up' | 'additive-both' | 'bidirectional';

export interface LocalItem {
  stableKey: StableKey;
  chromeId: string;
  url: string;
  title: string;
  folderPath: FolderPath;
  contentHash: string;
}

export interface RemoteItem {
  stableKey: StableKey;
  lwLinkId: number;
  url: string;
  title: string;
  folderPath: FolderPath;
  contentHash: string;
  tags: string[];
}

export interface SyncedItem {
  stableKey: StableKey;
  chromeId: string | null;
  lwLinkId: number | null;
  url: string;
  title: string;
  folderPath: FolderPath;
  contentHash: string;
  lastSyncedAt: number;
}

export interface SyncState {
  schemaVersion: 1;
  items: Record<StableKey, SyncedItem>;
  folders: Record<FolderPath, number>;
  lastSyncAt: number | null;
  lastResult: 'ok' | 'blocked' | 'error' | null;
}

interface SyncActionBase {
  stableKey: StableKey;
  reason: string;
}

export interface CreateRemoteAction extends SyncActionBase {
  type: 'createRemote';
  payload: { local: LocalItem };
}

export interface CreateLocalAction extends SyncActionBase {
  type: 'createLocal';
  payload: { remote: RemoteItem };
}

export interface UpdateRemoteAction extends SyncActionBase {
  type: 'updateRemote';
  payload: { local: LocalItem; remote: RemoteItem };
}

export interface UpdateLocalAction extends SyncActionBase {
  type: 'updateLocal';
  payload: { local: LocalItem; remote: RemoteItem };
}

export interface DeleteRemoteAction extends SyncActionBase {
  type: 'deleteRemote';
  payload: { remote: RemoteItem };
}

/**
 * Adopts a remote link with identical content by adding the "browser-sync"
 * tag. Needed for existing or imported links (e.g. via Floccus) that
 * Syncwarden did not create. Changes no metadata and is not a deletion.
 */
export interface AdoptRemoteAction extends SyncActionBase {
  type: 'adoptRemote';
  payload: { local: LocalItem; remote: RemoteItem };
}

export interface DeleteLocalAction extends SyncActionBase {
  type: 'deleteLocal';
  payload: { local: LocalItem };
}

export type SyncAction =
  | CreateRemoteAction
  | CreateLocalAction
  | UpdateRemoteAction
  | UpdateLocalAction
  | DeleteRemoteAction
  | AdoptRemoteAction
  | DeleteLocalAction;

export interface StateUpsert {
  item: SyncedItem;
  commit: 'immediate' | 'after-action';
}

export interface SyncStateDelta {
  upsert: Record<StableKey, StateUpsert>;
  remove: StableKey[];
}

export interface PlanNotice {
  type: 'duplicate-local' | 'duplicate-remote';
  stableKey: StableKey;
  message: string;
}

export interface SyncPlan {
  actions: SyncAction[];
  stateDelta: SyncStateDelta;
  notices: PlanNotice[];
  deletionCount: number;
  blocked: boolean;
  blockReason?: string;
}

export interface SyncStateRecovery {
  state: SyncState;
  recoveredFromCorruption: boolean;
}

export function createEmptySyncState(): SyncState {
  return {
    schemaVersion: 1,
    items: {},
    folders: {},
    lastSyncAt: null,
    lastResult: null,
  };
}

export function recoverSyncState(value: unknown): SyncStateRecovery {
  if (!isSyncState(value)) {
    return {
      state: createEmptySyncState(),
      recoveredFromCorruption: value !== null && value !== undefined,
    };
  }

  return { state: value, recoveredFromCorruption: false };
}

function isSyncState(value: unknown): value is SyncState {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    return false;
  }
  if (!isRecord(value.items) || !isRecord(value.folders)) {
    return false;
  }
  if (value.lastSyncAt !== null && !isFiniteNumber(value.lastSyncAt)) {
    return false;
  }
  if (
    value.lastResult !== null &&
    value.lastResult !== 'ok' &&
    value.lastResult !== 'blocked' &&
    value.lastResult !== 'error'
  ) {
    return false;
  }

  return (
    Object.entries(value.items).every(
      ([key, item]) => isSyncedItem(item) && item.stableKey === key,
    ) &&
    Object.values(value.folders).every(
      (collectionId) => isFiniteNumber(collectionId),
    )
  );
}

function isSyncedItem(value: unknown): value is SyncedItem {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.stableKey === 'string' &&
    (typeof value.chromeId === 'string' || value.chromeId === null) &&
    (isFiniteNumber(value.lwLinkId) || value.lwLinkId === null) &&
    typeof value.url === 'string' &&
    typeof value.title === 'string' &&
    typeof value.folderPath === 'string' &&
    typeof value.contentHash === 'string' &&
    isFiniteNumber(value.lastSyncedAt)
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
