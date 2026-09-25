import type { RemoteLinkRecord } from './linkwarden';
import type {
  LocalItem,
  SyncMode,
  SyncPlan,
  SyncState,
} from '../core/types';
import { createEmptySyncState, recoverSyncState } from '../core/types';

export interface LinkwardenSettings {
  baseUrl: string;
  token: string;
}

const SETTINGS_KEY = 'linkwardenSettings';
const SYNC_STATE_KEY = 'syncState';
const SYNC_PREFERENCES_KEY = 'syncPreferences';
const SYNC_LOG_KEY = 'syncLog';
const SYNC_STATUS_KEY = 'syncStatus';
const SYNC_JOB_KEY = 'syncJob';
const PENDING_PLAN_KEY = 'pendingPlan';
let syncLogWriteTail: Promise<void> = Promise.resolve();

export interface SyncPreferences {
  mode: SyncMode;
  intervalMinutes: number;
  dryRun: boolean;
}

export interface SyncLogEntry {
  id: string;
  at: number;
  type: string;
  reason: string;
  status: 'ok' | 'skipped' | 'error' | 'blocked';
}

export interface SyncStatus {
  running: boolean;
  lastSyncAt: number | null;
  lastResult: 'ok' | 'blocked' | 'error' | null;
  createdRemote: number;
  createdLocal: number;
  updatedRemote: number;
  updatedLocal: number;
  deletedRemote: number;
  deletedLocal: number;
  skipped: number;
  error: string | null;
}

export interface PersistedSyncJob {
  id: string;
  trigger: 'manual' | 'alarm' | 'bookmark-event' | 'resume';
  stage: 'scan-remote' | 'execute';
  cursor: number | null;
  local: LocalItem[];
  remote: RemoteLinkRecord[];
  skippedRemoteIds: number[];
  unsafeSkippedRemoteIds: number[];
  unknownRemoteSkipCount: number;
  plan: SyncPlan | null;
  nextActionIndex: number;
  inFlightStableKey: string | null;
  batchEndIndex: number;
}

export const DEFAULT_SYNC_PREFERENCES: SyncPreferences = {
  mode: 'additive-up',
  intervalMinutes: 15,
  dryRun: false,
};

export const EMPTY_SYNC_STATUS: SyncStatus = {
  running: false,
  lastSyncAt: null,
  lastResult: null,
  createdRemote: 0,
  createdLocal: 0,
  updatedRemote: 0,
  updatedLocal: 0,
  deletedRemote: 0,
  deletedLocal: 0,
  skipped: 0,
  error: null,
};

export async function loadLinkwardenSettings(): Promise<LinkwardenSettings | null> {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  const value: unknown = result[SETTINGS_KEY];

  if (!isLinkwardenSettings(value)) {
    return null;
  }

  return value;
}

export async function saveLinkwardenSettings(
  settings: LinkwardenSettings,
): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

export async function commitConnectionConfiguration(
  settings: LinkwardenSettings,
  preferences: SyncPreferences,
  resetSyncData: boolean,
): Promise<void> {
  if (!isLinkwardenSettings(settings)) {
    throw new Error('Invalid Linkwarden connection settings.');
  }
  if (!isSyncPreferences(preferences)) {
    throw new Error('Invalid sync settings.');
  }
  await chrome.storage.local.set({
    [SETTINGS_KEY]: settings,
    [SYNC_PREFERENCES_KEY]: preferences,
    ...(resetSyncData
      ? {
          [SYNC_STATE_KEY]: createEmptySyncState(),
          [SYNC_JOB_KEY]: null,
          [PENDING_PLAN_KEY]: null,
          [SYNC_STATUS_KEY]: EMPTY_SYNC_STATUS,
        }
      : {}),
  });
}

export async function loadSyncState(): Promise<{
  state: SyncState;
  recoveredFromCorruption: boolean;
}> {
  const stored = await chrome.storage.local.get(SYNC_STATE_KEY);
  const raw: unknown = stored[SYNC_STATE_KEY];
  const recovery = recoverSyncState(raw);
  if (recovery.recoveredFromCorruption) {
    await chrome.storage.local.set({
      syncStateCorruptBackup: { at: Date.now(), value: raw },
    });
  }
  return recovery;
}

export async function saveSyncState(state: SyncState): Promise<void> {
  await chrome.storage.local.set({ [SYNC_STATE_KEY]: state });
}

export async function loadSyncPreferences(): Promise<SyncPreferences> {
  const stored = await chrome.storage.local.get(SYNC_PREFERENCES_KEY);
  const value: unknown = stored[SYNC_PREFERENCES_KEY];
  return isSyncPreferences(value) ? value : DEFAULT_SYNC_PREFERENCES;
}

export async function saveSyncPreferences(
  preferences: SyncPreferences,
): Promise<void> {
  if (!isSyncPreferences(preferences)) {
    throw new Error('Invalid sync settings.');
  }
  await chrome.storage.local.set({ [SYNC_PREFERENCES_KEY]: preferences });
}

export async function loadSyncLog(): Promise<SyncLogEntry[]> {
  const stored = await chrome.storage.local.get(SYNC_LOG_KEY);
  const value: unknown = stored[SYNC_LOG_KEY];
  return Array.isArray(value) ? value.filter(isSyncLogEntry).slice(0, 50) : [];
}

export async function appendSyncLog(
  entries: SyncLogEntry | SyncLogEntry[],
): Promise<void> {
  const write = syncLogWriteTail.then(async () => {
    const current = await loadSyncLog();
    const incoming = Array.isArray(entries) ? entries : [entries];
    await chrome.storage.local.set({
      [SYNC_LOG_KEY]: [...incoming, ...current].slice(0, 50),
    });
  });
  syncLogWriteTail = write.catch(() => undefined);
  return write;
}

export async function loadSyncStatus(): Promise<SyncStatus> {
  const stored = await chrome.storage.local.get(SYNC_STATUS_KEY);
  const value: unknown = stored[SYNC_STATUS_KEY];
  return isSyncStatus(value) ? value : EMPTY_SYNC_STATUS;
}

export async function saveSyncStatus(status: SyncStatus): Promise<void> {
  await chrome.storage.local.set({ [SYNC_STATUS_KEY]: status });
}

export async function loadSyncJob(): Promise<PersistedSyncJob | null> {
  const stored = await chrome.storage.local.get(SYNC_JOB_KEY);
  const value: unknown = stored[SYNC_JOB_KEY];
  if (value === null || value === undefined) {
    return null;
  }
  if (isPersistedSyncJob(value)) {
    return value;
  }
  await quarantineCorruptWork(
    'syncJobCorruptBackup',
    SYNC_JOB_KEY,
    value,
    'The saved sync job was corrupt and has been discarded safely.',
  );
  return null;
}

export async function saveSyncJob(job: PersistedSyncJob): Promise<void> {
  await chrome.storage.local.set({ [SYNC_JOB_KEY]: job });
}

export async function clearSyncJob(): Promise<void> {
  await chrome.storage.local.remove(SYNC_JOB_KEY);
}

export interface PendingPlan {
  createdAt: number;
  blockReason: string;
  job: PersistedSyncJob;
}

export async function loadPendingPlan(): Promise<PendingPlan | null> {
  const stored = await chrome.storage.local.get(PENDING_PLAN_KEY);
  const value: unknown = stored[PENDING_PLAN_KEY];
  if (value === null || value === undefined) {
    return null;
  }
  if (
    !isRecord(value) ||
    typeof value.createdAt !== 'number' ||
    typeof value.blockReason !== 'string' ||
    !isPersistedSyncJob(value.job)
  ) {
    await quarantineCorruptWork(
      'pendingPlanCorruptBackup',
      PENDING_PLAN_KEY,
      value,
      'The saved approval plan was corrupt and has been discarded safely.',
    );
    return null;
  }
  return { createdAt: value.createdAt, blockReason: value.blockReason, job: value.job };
}

export async function savePendingPlan(pending: PendingPlan): Promise<void> {
  await chrome.storage.local.set({ [PENDING_PLAN_KEY]: pending });
}

export async function clearPendingPlan(): Promise<void> {
  await chrome.storage.local.remove(PENDING_PLAN_KEY);
}

export async function resetSyncAfterRestore(): Promise<void> {
  await chrome.storage.local.set({
    [SYNC_STATE_KEY]: createEmptySyncState(),
    [SYNC_JOB_KEY]: null,
    [PENDING_PLAN_KEY]: null,
  });
}

function isLinkwardenSettings(value: unknown): value is LinkwardenSettings {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.baseUrl === 'string' &&
    candidate.baseUrl.length > 0 &&
    typeof candidate.token === 'string' &&
    candidate.token.length > 0
  );
}

function isSyncPreferences(value: unknown): value is SyncPreferences {
  if (!isRecord(value)) {
    return false;
  }
  return (
    (value.mode === 'additive-up' ||
      value.mode === 'additive-both' ||
      value.mode === 'bidirectional') &&
    typeof value.intervalMinutes === 'number' &&
    value.intervalMinutes >= 5 &&
    value.intervalMinutes <= 120 &&
    typeof value.dryRun === 'boolean'
  );
}

function isSyncLogEntry(value: unknown): value is SyncLogEntry {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === 'string' &&
    Number.isFinite(value.at) &&
    typeof value.type === 'string' &&
    typeof value.reason === 'string' &&
    (value.status === 'ok' ||
      value.status === 'skipped' ||
      value.status === 'error' ||
      value.status === 'blocked')
  );
}

function isSyncStatus(value: unknown): value is SyncStatus {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.running === 'boolean' &&
    (value.lastSyncAt === null || Number.isFinite(value.lastSyncAt)) &&
    (value.lastResult === null ||
      value.lastResult === 'ok' ||
      value.lastResult === 'blocked' ||
      value.lastResult === 'error') &&
    isNonNegativeInteger(value.createdRemote) &&
    isNonNegativeInteger(value.createdLocal) &&
    isNonNegativeInteger(value.updatedRemote) &&
    isNonNegativeInteger(value.updatedLocal) &&
    isNonNegativeInteger(value.deletedRemote) &&
    isNonNegativeInteger(value.deletedLocal) &&
    isNonNegativeInteger(value.skipped) &&
    (value.error === null || typeof value.error === 'string')
  );
}

function isPersistedSyncJob(value: unknown): value is PersistedSyncJob {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === 'string' &&
    (value.trigger === 'manual' ||
      value.trigger === 'alarm' ||
      value.trigger === 'bookmark-event' ||
      value.trigger === 'resume') &&
    (value.stage === 'scan-remote' || value.stage === 'execute') &&
    (value.cursor === null || isNonNegativeInteger(value.cursor)) &&
    Array.isArray(value.local) &&
    value.local.every(isLocalItem) &&
    Array.isArray(value.remote) &&
    value.remote.every(isRemoteLinkRecord) &&
    Array.isArray(value.skippedRemoteIds) &&
    value.skippedRemoteIds.every((id) => typeof id === 'number') &&
    Array.isArray(value.unsafeSkippedRemoteIds) &&
    value.unsafeSkippedRemoteIds.every((id) => typeof id === 'number') &&
    typeof value.unknownRemoteSkipCount === 'number' &&
    Number.isInteger(value.unknownRemoteSkipCount) &&
    value.unknownRemoteSkipCount >= 0 &&
    (value.plan === null || isSyncPlan(value.plan)) &&
    isNonNegativeInteger(value.nextActionIndex) &&
    (value.inFlightStableKey === null ||
      typeof value.inFlightStableKey === 'string') &&
    isNonNegativeInteger(value.batchEndIndex) &&
    (value.plan === null ||
      (value.nextActionIndex <= value.plan.actions.length &&
        value.batchEndIndex <= value.plan.actions.length))
  );
}

function isLocalItem(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.stableKey === 'string' &&
    typeof value.chromeId === 'string' &&
    typeof value.url === 'string' &&
    typeof value.title === 'string' &&
    typeof value.folderPath === 'string' &&
    typeof value.contentHash === 'string'
  );
}

function isRemoteItem(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.stableKey === 'string' &&
    isNonNegativeInteger(value.lwLinkId) &&
    typeof value.url === 'string' &&
    typeof value.title === 'string' &&
    typeof value.folderPath === 'string' &&
    typeof value.contentHash === 'string' &&
    Array.isArray(value.tags) &&
    value.tags.every((tag) => typeof tag === 'string')
  );
}

function isRemoteLinkRecord(value: unknown): boolean {
  if (!isRecord(value) || !isRemoteItem(value.item) || !isRecord(value.raw)) {
    return false;
  }
  return (
    typeof value.raw.id === 'number' &&
    (typeof value.raw.name === 'string' || value.raw.name === null) &&
    typeof value.raw.url === 'string' &&
    Array.isArray(value.raw.tags)
  );
}

function isSyncPlan(value: unknown): value is SyncPlan {
  if (!isRecord(value) || !Array.isArray(value.actions)) {
    return false;
  }
  return (
    value.actions.every(isSyncAction) &&
    isRecord(value.stateDelta) &&
    isRecord(value.stateDelta.upsert) &&
    Object.values(value.stateDelta.upsert).every(isStateUpsert) &&
    Array.isArray(value.stateDelta.remove) &&
    value.stateDelta.remove.every((key) => typeof key === 'string') &&
    Array.isArray(value.notices) &&
    value.notices.every(isPlanNotice) &&
    isNonNegativeInteger(value.deletionCount) &&
    typeof value.blocked === 'boolean' &&
    (value.blockReason === undefined || typeof value.blockReason === 'string')
  );
}

function isSyncAction(value: unknown): boolean {
  if (
    !isRecord(value) ||
    typeof value.stableKey !== 'string' ||
    typeof value.reason !== 'string' ||
    !isRecord(value.payload)
  ) {
    return false;
  }
  switch (value.type) {
    case 'createRemote':
    case 'deleteLocal':
      return isLocalItem(value.payload.local);
    case 'createLocal':
    case 'deleteRemote':
      return isRemoteItem(value.payload.remote);
    case 'updateRemote':
    case 'updateLocal':
    case 'adoptRemote':
      return (
        isLocalItem(value.payload.local) &&
        isRemoteItem(value.payload.remote)
      );
    default:
      return false;
  }
}

function isStateUpsert(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.commit === 'immediate' || value.commit === 'after-action') &&
    isRecord(value.item) &&
    typeof value.item.stableKey === 'string' &&
    (typeof value.item.chromeId === 'string' || value.item.chromeId === null) &&
    (typeof value.item.lwLinkId === 'number' || value.item.lwLinkId === null) &&
    typeof value.item.contentHash === 'string'
  );
}

function isPlanNotice(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.type === 'duplicate-local' || value.type === 'duplicate-remote') &&
    typeof value.stableKey === 'string' &&
    typeof value.message === 'string'
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= 0
  );
}

async function quarantineCorruptWork(
  backupKey: string,
  workKey: string,
  value: unknown,
  message: string,
): Promise<void> {
  await chrome.storage.local.set({
    [backupKey]: { at: Date.now(), value },
    [workKey]: null,
    [SYNC_STATUS_KEY]: {
      ...EMPTY_SYNC_STATUS,
      lastSyncAt: Date.now(),
      lastResult: 'error',
      error: message,
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
