import { buildPlan } from '../core/sync-engine';
import { remotePathToLocalPath, unescapePathSegment } from '../core/paths';
import type {
  StateUpsert,
  SyncAction,
  SyncPlan,
  SyncState,
  SyncedItem,
} from '../core/types';
import { createEmptySyncState } from '../core/types';
import {
  ChromeBookmarksAdapter,
  withBookmarkWriteMutex,
} from './bookmarks';
import {
  DEFAULT_COLLECTION_NAME,
  LinkwardenClient,
  type LinkwardenCollection,
  type LinkwardenLink,
  type RemoteLinkRecord,
} from './linkwarden';
import {
  createSnapshot,
  getSnapshot,
  listSnapshots,
  restoreLocalTree,
  type SyncSnapshot,
} from './snapshots';
import {
  EMPTY_SYNC_STATUS,
  appendSyncLog,
  clearPendingPlan,
  clearSyncJob,
  loadLinkwardenSettings,
  loadPendingPlan,
  loadSyncJob,
  loadSyncLog,
  loadSyncPreferences,
  loadSyncState,
  loadSyncStatus,
  commitConnectionConfiguration as persistConnectionConfiguration,
  savePendingPlan,
  resetSyncAfterRestore,
  saveSyncJob,
  saveSyncState,
  saveSyncStatus,
  type PendingPlan,
  type PersistedSyncJob,
  type SyncLogEntry,
  type SyncStatus,
  type LinkwardenSettings,
  type SyncPreferences,
} from './storage';

const ACTION_BATCH_SIZE = 10;
// Relative to the extension root, same file as the toolbar icon.
const NOTIFICATION_ICON = 'icon/128.png';

let activeRun: Promise<void> | null = null;
let queuedTrigger: PersistedSyncJob['trigger'] | null = null;

export async function requestSync(
  trigger: PersistedSyncJob['trigger'],
): Promise<void> {
  if (activeRun !== null) {
    queuedTrigger = trigger;
    return activeRun;
  }
  return startExclusiveOperation(() => runSync(trigger));
}

function startExclusiveOperation(operation: () => Promise<void>): Promise<void> {
  queuedTrigger = null;
  const queuedOperation = runOperationAndQueuedSyncs(operation).finally(() => {
    activeRun = null;
  });
  activeRun = queuedOperation;
  return queuedOperation;
}

async function runOperationAndQueuedSyncs(
  operation: () => Promise<void>,
): Promise<void> {
  let firstError: unknown;
  try {
    await operation();
  } catch (error) {
    firstError = error;
  }

  while (queuedTrigger !== null) {
    const trigger = queuedTrigger;
    queuedTrigger = null;
    try {
      await runSync(trigger);
    } catch (error) {
      firstError ??= error;
    }
  }

  if (firstError !== undefined) {
    throw firstError;
  }
}

export async function getSyncDashboard(): Promise<{
  status: SyncStatus;
  log: SyncLogEntry[];
  pending: PendingPlan | null;
}> {
  // Load the pending plan first: if it is corrupt, the loader quarantines it
  // and writes a recovery status that we read right after.
  const pending = await loadPendingPlan();
  const [status, log] = await Promise.all([loadSyncStatus(), loadSyncLog()]);
  return { status, log, pending };
}

export async function commitConnectionConfiguration(
  settings: LinkwardenSettings,
  preferences: SyncPreferences,
): Promise<void> {
  if (activeRun !== null) {
    throw new Error(
      'A sync is running. Save the connection again afterwards.',
    );
  }
  return startExclusiveOperation(async () => {
    const previous = await loadLinkwardenSettings();
    const changedAccount =
      previous === null ||
      previous.baseUrl !== settings.baseUrl ||
      previous.token !== settings.token;
    await persistConnectionConfiguration(
      settings,
      preferences,
      changedAccount,
    );
  });
}

async function runSync(trigger: PersistedSyncJob['trigger']): Promise<void> {
  const pending = await loadPendingPlan();
  if (pending !== null) {
    await saveSyncStatus({
      ...EMPTY_SYNC_STATUS,
      running: false,
      lastSyncAt: pending.createdAt,
      lastResult: 'blocked',
      error:
        'A held-back plan is waiting to be approved or discarded. No actions were run.',
    });
    return;
  }
  const previousStatus = await loadSyncStatus();
  await saveSyncStatus({ ...previousStatus, running: true, error: null });

  try {
    const settings = await loadLinkwardenSettings();
    if (settings === null) {
      throw new Error(
        'Linkwarden is not connected. Check URL and token in the settings.',
      );
    }
    const preferences = await loadSyncPreferences();
    const recovered = await loadSyncState();
    let state = recovered.state;
    const bookmarks = new ChromeBookmarksAdapter();
    const client = new LinkwardenClient(settings);
    const interruptedJob = await loadSyncJob();
    if (interruptedJob !== null) {
      await clearSyncJob();
      await appendSyncLog({
        id: crypto.randomUUID(),
        at: Date.now(),
        type: 'replan',
        reason:
          'Interrupted sync discarded; local and remote bookmarks are read again before anything else happens.',
        status: 'skipped',
      });
    }
    let job = await createFreshScanJob(bookmarks, trigger);

    if (job.stage === 'scan-remote') {
      job = await scanRemote(client, job);
      await logRemoteSkips(job);
      assertRemoteScanComplete(job, state);
      const mode = recovered.recoveredFromCorruption
        ? preferences.mode === 'additive-up'
          ? 'additive-up'
          : 'additive-both'
        : preferences.mode;
      const plan = buildPlan(
        job.local,
        job.remote.map((record) => record.item),
        state,
        mode,
        Date.now(),
      );
      await logPlanNotices(plan);

      if (plan.blocked) {
        const reason = plan.blockReason ?? 'Sync plan held back.';
        await appendSyncLog({
          id: crypto.randomUUID(),
          at: Date.now(),
          type: 'blocked',
          reason,
          status: 'blocked',
        });
        await notifyBlocked(plan);
        await savePendingPlan({
          createdAt: Date.now(),
          blockReason: reason,
          job: { ...job, stage: 'execute', plan, nextActionIndex: 0, batchEndIndex: 0 },
        });
        await clearSyncJob();
        await saveSyncStatus({
          ...EMPTY_SYNC_STATUS,
          running: false,
          lastSyncAt: Date.now(),
          lastResult: 'blocked',
          skipped: plan.notices.length,
          error: reason,
        });
        return;
      }

      if (preferences.dryRun) {
        await logDryRun(plan);
        await clearSyncJob();
        await saveSyncStatus({
          ...EMPTY_SYNC_STATUS,
          running: false,
          lastSyncAt: Date.now(),
          lastResult: 'ok',
          skipped: plan.actions.length + plan.notices.length,
          error: null,
        });
        return;
      }

      state = applyImmediateDelta(state, plan);
      await saveSyncState(state);
      job = {
        ...job,
        stage: 'execute',
        plan,
        nextActionIndex: 0,
        batchEndIndex: 0,
      };
      await saveSyncJob(job);
    }

    await executeJob(client, bookmarks, job, state);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown sync error.';
    await clearSyncJob();
    await appendSyncLog({
      id: crypto.randomUUID(),
      at: Date.now(),
      type: 'syncError',
      reason: message,
      status: 'error',
    });
    await saveSyncStatus({
      ...EMPTY_SYNC_STATUS,
      running: false,
      lastSyncAt: Date.now(),
      lastResult: 'error',
      error: message,
    });
    throw error;
  }
}

async function executeJob(
  client: LinkwardenClient,
  bookmarks: ChromeBookmarksAdapter,
  initialJob: PersistedSyncJob,
  initialState: SyncState,
): Promise<void> {
  if (initialJob.plan === null) {
    throw new Error('The saved sync plan is missing. Start the sync again.');
  }
  const executionPlan: SyncPlan = initialJob.plan;
  let job = initialJob;
  let state = initialState;
  const ownerId = await client.getCurrentUserId();
  const collections = (await client.listCollections()).filter(
    (collection) => collection.ownerId === ownerId,
  );
  const collectionsById = new Map<number, LinkwardenCollection>(
    collections.map((collection) => [collection.id, collection]),
  );
  const counters = emptyCounters(executionPlan.notices.length);
  while (job.nextActionIndex < executionPlan.actions.length) {
    if (job.nextActionIndex >= job.batchEndIndex) {
      const end = Math.min(
        job.nextActionIndex + ACTION_BATCH_SIZE,
        executionPlan.actions.length,
      );
      await createSnapshot({
        reason: `Before actions ${job.nextActionIndex + 1}–${end}`,
        remoteBefore: job.remote.map((record) => record.raw),
        state,
      });
      job = { ...job, batchEndIndex: end };
      await saveSyncJob(job);
    }

    const action: SyncAction | undefined =
      executionPlan.actions[job.nextActionIndex];
    if (action === undefined) {
      throw new Error('Sync action missing from the saved plan.');
    }
    job = { ...job, inFlightStableKey: action.stableKey };
    await saveSyncJob(job);
    const result = await executeAction(
      client,
      bookmarks,
      collections,
      collectionsById,
      ownerId,
      action,
    );
    state = applySuccessfulActionDelta(state, executionPlan, action, result);
    await saveSyncState(state);
    incrementCounter(counters, action.type);
    await appendSyncLog(actionLog(action));
    job = {
      ...job,
      nextActionIndex: job.nextActionIndex + 1,
      inFlightStableKey: null,
    };
    await saveSyncJob(job);
  }

  const completedAt = Date.now();
  state = { ...state, lastSyncAt: completedAt, lastResult: 'ok' };
  await saveSyncState(state);
  await clearSyncJob();
  await saveSyncStatus({
    ...counters,
    running: false,
    lastSyncAt: completedAt,
    lastResult: 'ok',
    error: null,
  });
}

export async function getPendingPlan(): Promise<PendingPlan | null> {
  return loadPendingPlan();
}

export async function listSyncSnapshots(): Promise<
  Array<Pick<SyncSnapshot, 'id' | 'createdAt' | 'reason'>>
> {
  const snapshots = await listSnapshots();
  return snapshots.map(({ id, createdAt, reason }) => ({
    id,
    createdAt,
    reason,
  }));
}

export async function restoreSnapshot(id: string): Promise<void> {
  if (activeRun !== null) {
    throw new Error('A sync is running. Restore once it has finished.');
  }
  return startExclusiveOperation(() => performSnapshotRestore(id));
}

async function performSnapshotRestore(id: string): Promise<void> {
  const snapshot = await getSnapshot(id);
  if (snapshot === null) {
    throw new Error('Snapshot not found.');
  }
  const previousState = (await loadSyncState()).state;
  await withBookmarkWriteMutex(async () => {
    const safetySnapshot = await createSnapshot({
      reason: `Before restoring snapshot ${snapshot.id}`,
      remoteBefore: [],
      state: previousState,
    });
    try {
      await restoreLocalTree(snapshot);
      // Remote is deliberately not rolled back. An empty state makes the next
      // run additive: it merges both sides instead of deriving new deletions
      // from stale ownership marks.
      await resetSyncAfterRestore();
    } catch (error) {
      try {
        await restoreLocalTree(safetySnapshot);
        await saveSyncState(createEmptySyncState());
      } catch (rollbackError) {
        const primary = error instanceof Error ? error.message : String(error);
        const rollback =
          rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError);
        throw new Error(
          `Restore failed (${primary}); restoring the automatic backup failed as well (${rollback}).`,
        );
      }
      throw error;
    }
  });
  await appendSyncLog({
    id: crypto.randomUUID(),
    at: Date.now(),
    type: 'restore',
    reason: `Bookmarks restored from the snapshot of ${new Date(
      snapshot.createdAt,
    ).toLocaleString()}.`,
    status: 'ok',
  });
}

export async function discardPendingPlan(): Promise<void> {
  if (activeRun !== null) {
    throw new Error(
      'A sync operation is already running. The plan can’t be discarded right now.',
    );
  }
  return startExclusiveOperation(performDiscardPendingPlan);
}

async function performDiscardPendingPlan(): Promise<void> {
  await clearPendingPlan();
  await appendSyncLog({
    id: crypto.randomUUID(),
    at: Date.now(),
    type: 'planDiscarded',
    reason: 'Held-back plan discarded.',
    status: 'ok',
  });
}

export async function savePageToLinkwarden(input: {
  name: string;
  url: string;
}): Promise<void> {
  if (activeRun !== null) {
    throw new Error(
      'A sync operation is already running. Save the page again afterwards.',
    );
  }
  return startExclusiveOperation(async () => {
    const settings = await loadLinkwardenSettings();
    if (settings === null) {
      throw new Error('Linkwarden is not connected.');
    }
    await new LinkwardenClient(settings).createLink(input);
  });
}

export async function approvePendingPlan(): Promise<void> {
  if (activeRun !== null) {
    throw new Error(
      'A sync operation is already running. Approval not started.',
    );
  }
  return startExclusiveOperation(runApprovedPlan);
}

async function runApprovedPlan(): Promise<void> {
  const pending = await loadPendingPlan();
  if (pending === null) {
    throw new Error('There is no held-back plan to approve.');
  }
  const previousStatus = await loadSyncStatus();
  await saveSyncStatus({ ...previousStatus, running: true, error: null });
  try {
    const settings = await loadLinkwardenSettings();
    if (settings === null) {
      throw new Error(
        'Linkwarden is not connected. Check URL and token in the settings.',
      );
    }
    const client = new LinkwardenClient(settings);
    const bookmarks = new ChromeBookmarksAdapter();
    const recovered = await loadSyncState();
    if (recovered.recoveredFromCorruption) {
      throw new Error(
        'Sync state is corrupt. The held-back plan was not run.',
      );
    }
    const approvedPlan = pending.job.plan;
    if (approvedPlan === null) {
      throw new Error('The held-back plan has no actions.');
    }
    const preferences = await loadSyncPreferences();
    let job = await createFreshScanJob(bookmarks, 'manual');
    job = await scanRemote(client, job);
    await logRemoteSkips(job);
    assertRemoteScanComplete(job, recovered.state);
    const plan = buildPlan(
      job.local,
      job.remote.map((record) => record.item),
      recovered.state,
      preferences.mode,
      Date.now(),
    );
    await logPlanNotices(plan);

    if (planFingerprint(plan) !== planFingerprint(approvedPlan)) {
      const reason =
        'Bookmarks changed since the plan was shown. Review the recalculated plan.';
      const reviewPlan: SyncPlan = {
        ...plan,
        blocked: true,
        blockReason: reason,
      };
      await savePendingPlan({
        createdAt: Date.now(),
        blockReason: reason,
        job: {
          ...job,
          stage: 'execute',
          plan: reviewPlan,
          nextActionIndex: 0,
          inFlightStableKey: null,
          batchEndIndex: 0,
        },
      });
      await clearSyncJob();
      await appendSyncLog({
        id: crypto.randomUUID(),
        at: Date.now(),
        type: 'planChanged',
        reason,
        status: 'blocked',
      });
      await saveSyncStatus({
        ...EMPTY_SYNC_STATUS,
        running: false,
        lastSyncAt: Date.now(),
        lastResult: 'blocked',
        skipped: plan.notices.length,
        error: reason,
      });
      return;
    }

    job = {
      ...job,
      stage: 'execute',
      plan,
      nextActionIndex: 0,
      inFlightStableKey: null,
      batchEndIndex: 0,
    };
    let state = applyImmediateDelta(recovered.state, plan);
    const latestPending = await loadPendingPlan();
    if (
      latestPending === null ||
      latestPending.createdAt !== pending.createdAt ||
      latestPending.job.id !== pending.job.id
    ) {
      throw new Error(
        'The plan was changed or discarded in the meantime.',
      );
    }
    await saveSyncState(state);
    await appendSyncLog({
      id: crypto.randomUUID(),
      at: Date.now(),
      type: 'planApproved',
      reason: `Held-back plan approved (${plan.deletionCount} deletions).`,
      status: 'ok',
    });
    await clearPendingPlan();
    await saveSyncJob(job);
    await executeJob(client, bookmarks, job, state);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown sync error.';
    await clearSyncJob();
    await appendSyncLog({
      id: crypto.randomUUID(),
      at: Date.now(),
      type: 'syncError',
      reason: message,
      status: 'error',
    });
    await saveSyncStatus({
      ...EMPTY_SYNC_STATUS,
      running: false,
      lastSyncAt: Date.now(),
      lastResult: 'error',
      error: message,
    });
    throw error;
  }
}

async function logDryRun(plan: SyncPlan): Promise<void> {
  const entries: SyncLogEntry[] = plan.actions.map((action) => ({
    id: crypto.randomUUID(),
    at: Date.now(),
    type: `dryRun:${action.type}`,
    reason: action.reason,
    status: 'skipped' as const,
  }));
  entries.unshift({
    id: crypto.randomUUID(),
    at: Date.now(),
    type: 'dryRun',
    reason: `Dry run: ${plan.actions.length} actions, ${plan.deletionCount} deletions. Nothing written.`,
    status: 'skipped',
  });
  await appendSyncLog(entries);
}

async function createFreshScanJob(
  bookmarks: ChromeBookmarksAdapter,
  trigger: PersistedSyncJob['trigger'],
): Promise<PersistedSyncJob> {
  const inventory = await bookmarks.readInventory();
  const job: PersistedSyncJob = {
    id: crypto.randomUUID(),
    trigger,
    stage: 'scan-remote',
    cursor: null,
    local: inventory.items,
    remote: [],
    skippedRemoteIds: [],
    unsafeSkippedRemoteIds: [],
    unknownRemoteSkipCount: 0,
    plan: null,
    nextActionIndex: 0,
    inFlightStableKey: null,
    batchEndIndex: 0,
  };
  await saveSyncJob(job);
  if (inventory.skipped.length > 0) {
    await appendSyncLog(
      inventory.skipped.map((item) => ({
        id: crypto.randomUUID(),
        at: Date.now(),
        type: 'skipLocal',
        reason: `${item.title}: ${item.reason}`,
        status: 'skipped' as const,
      })),
    );
  }
  return job;
}

async function logPlanNotices(plan: SyncPlan): Promise<void> {
  if (plan.notices.length === 0) {
    return;
  }
  await appendSyncLog(
    plan.notices.map((notice) => ({
      id: crypto.randomUUID(),
      at: Date.now(),
      type: `notice:${notice.type}`,
      reason: `${notice.message} (${notice.stableKey})`,
      status: 'skipped' as const,
    })),
  );
}

async function logRemoteSkips(job: PersistedSyncJob): Promise<void> {
  const skippedCount =
    job.skippedRemoteIds.length + job.unknownRemoteSkipCount;
  if (skippedCount === 0) {
    return;
  }
  await appendSyncLog({
    id: crypto.randomUUID(),
    at: Date.now(),
    type: 'skipRemote',
    reason: `${skippedCount} remote entries could not be read as browser bookmarks.`,
    status: 'skipped',
  });
}

function assertRemoteScanComplete(
  job: PersistedSyncJob,
  state: SyncState,
): void {
  const knownRemoteIds = new Set(
    Object.values(state.items).flatMap((item) =>
      item.lwLinkId === null ? [] : [item.lwLinkId],
    ),
  );
  const hiddenKnownIds = job.skippedRemoteIds.filter((id) =>
    knownRemoteIds.has(id),
  );
  if (
    job.unknownRemoteSkipCount > 0 ||
    job.unsafeSkippedRemoteIds.length > 0 ||
    hiddenKnownIds.length > 0
  ) {
    throw new Error(
      'The remote inventory is incomplete or contains unreadable links that were synced before. No actions were run, to be safe.',
    );
  }
}

function planFingerprint(plan: SyncPlan): string {
  return JSON.stringify({
    actions: plan.actions,
    notices: plan.notices,
    deletionCount: plan.deletionCount,
  });
}

async function scanRemote(
  client: LinkwardenClient,
  initial: PersistedSyncJob,
): Promise<PersistedSyncJob> {
  // Load collections once as an id -> collection map so listLinksPage can
  // resolve the full nested path (parentId chain).
  const collections = await client.listCollections();
  const ownerId = await client.getCurrentUserId();
  const byId = new Map<number, LinkwardenCollection>(
    collections.map((collection) => [collection.id, collection]),
  );
  let job = initial;
  const seenCursors = new Set<number>();
  if (job.cursor !== null) {
    seenCursors.add(job.cursor);
  }
  while (job.stage === 'scan-remote') {
    const page = await client.listLinksPage(job.cursor, byId, ownerId);
    const nextCursor = page.nextCursor;
    if (nextCursor !== null && seenCursors.has(nextCursor)) {
      throw new Error('Linkwarden pagination returned the same cursor twice.');
    }
    if (nextCursor !== null) {
      seenCursors.add(nextCursor);
    }
    job = {
      ...job,
      cursor: nextCursor,
      remote: [...job.remote, ...page.records],
      skippedRemoteIds: [...job.skippedRemoteIds, ...page.skippedIds],
      unsafeSkippedRemoteIds: [
        ...job.unsafeSkippedRemoteIds,
        ...page.unsafeSkippedIds,
      ],
      unknownRemoteSkipCount:
        job.unknownRemoteSkipCount + page.unknownSkippedCount,
    };
    await saveSyncJob(job);
    if (nextCursor === null) {
      return job;
    }
  }
  return job;
}

async function executeAction(
  client: LinkwardenClient,
  bookmarks: ChromeBookmarksAdapter,
  collections: LinkwardenCollection[],
  collectionsById: Map<number, LinkwardenCollection>,
  ownerId: number,
  action: SyncAction,
): Promise<LinkwardenLink | ChromeBookmarkResult | null> {
  if (action.type === 'createRemote') {
    await bookmarks.assertBookmarkUnchanged(action.payload.local);
    const collection = await resolveCollectionForPath(
      client,
      collections,
      action.payload.local.folderPath,
      ownerId,
    );
    return client.createLink({
      name: action.payload.local.title,
      url: action.payload.local.url,
      collection,
    });
  }
  if (action.type === 'updateRemote') {
    await bookmarks.assertBookmarkUnchanged(action.payload.local);
    const collection = await resolveCollectionForPath(
      client,
      collections,
      action.payload.local.folderPath,
      ownerId,
    );
    return client.updateLinkFromLocal(
      action.payload.local,
      action.payload.remote,
      collection,
      collectionsById,
    );
  }
  if (action.type === 'createLocal') {
    const remote = action.payload.remote;
    await client.assertLinkUnchanged(remote, collectionsById);
    return withBookmarkWriteMutex(async () => {
      const node = await bookmarks.createBookmark({
        url: remote.url,
        title: remote.title,
        folderPath: remotePathToLocalPath(remote.folderPath),
      });
      return { chromeId: node.id };
    });
  }
  if (action.type === 'updateLocal') {
    const remote = action.payload.remote;
    await client.assertLinkUnchanged(remote, collectionsById);
    return withBookmarkWriteMutex(async () => {
      const node = await bookmarks.updateBookmark(
        action.payload.local.chromeId,
        remote.stableKey,
        {
        url: remote.url,
        title: remote.title,
        folderPath: remotePathToLocalPath(remote.folderPath),
        },
        action.payload.local.contentHash,
      );
      return { chromeId: node.id };
    });
  }
  if (action.type === 'deleteRemote') {
    await client.deleteLink(action.payload.remote, collectionsById);
    return null;
  }
  if (action.type === 'adoptRemote') {
    // Only add the sync tag; nothing to write locally.
    await bookmarks.assertBookmarkUnchanged(action.payload.local);
    return client.adoptLink(action.payload.remote, collectionsById);
  }
  if (action.type === 'deleteLocal') {
    return withBookmarkWriteMutex(async () => {
      await bookmarks.deleteBookmark(
        action.payload.local.chromeId,
        action.payload.local.stableKey,
        action.payload.local.contentHash,
      );
      return null;
    });
  }
  throw new Error(`Unknown sync action: ${(action as SyncAction).type}`);
}

/**
 * Returns the target collection for a canonical remote path. The empty path
 * (a link directly in the bookmarks bar) maps to the default "Unorganized"
 * collection, because the server does not allow a null collection. Otherwise
 * the hierarchy is used or created.
 */
async function resolveCollectionForPath(
  client: LinkwardenClient,
  collections: LinkwardenCollection[],
  folderPath: string,
  ownerId: number,
): Promise<LinkwardenCollection> {
  const hasSegments = folderPath
    .split('/')
    .some((segment) => segment.trim().length > 0);
  if (!hasSegments) {
    return resolveUnorganizedCollection(client, collections, ownerId);
  }
  return ensureCollection(client, collections, folderPath, ownerId);
}

/**
 * Finds the default top-level "Unorganized" collection. Linkwarden always
 * has it (system collection). If it is missing anyway, it gets created so
 * top-level links always have a valid collection to go to.
 */
async function resolveUnorganizedCollection(
  client: LinkwardenClient,
  collections: LinkwardenCollection[],
  ownerId: number,
): Promise<LinkwardenCollection> {
  const existing = collections.find(
    (collection) =>
      collection.name === DEFAULT_COLLECTION_NAME &&
      (collection.parentId ?? null) === null,
  );
  if (existing !== undefined) {
    return existing;
  }
  const created = await client.createCollection(
    DEFAULT_COLLECTION_NAME,
    null,
  );
  if (created.ownerId !== ownerId) {
    throw new Error(
      'Linkwarden did not assign the default collection to the current user.',
    );
  }
  collections.push(created);
  return created;
}

/**
 * Makes sure the (possibly nested) collection for folderPath exists and
 * creates missing levels with the right parentId.
 * Example: "Work/Projects/2026" -> uses or creates Work, then Projects inside
 * it, then 2026. New levels are added to the collections array so later
 * actions find them without another API call.
 */
async function ensureCollection(
  client: LinkwardenClient,
  collections: LinkwardenCollection[],
  folderPath: string,
  ownerId: number,
): Promise<LinkwardenCollection> {
  const segments = folderPath
    .split('/')
    .filter((segment) => segment.length > 0)
    .map(unescapePathSegment);

  if (segments.length === 0) {
    throw new Error('Can’t create an empty collection path.');
  }

  let parentId: number | null = null;
  let current: LinkwardenCollection | undefined;

  for (const segment of segments) {
    // Look for the name on the current level (same parentId).
    const match = collections.find(
      (collection) =>
        collection.name === segment &&
        (collection.parentId ?? null) === parentId,
    );

    if (match !== undefined) {
      current = match;
    } else {
      current = await client.createCollection(segment, parentId);
      if (current.ownerId !== ownerId) {
        throw new Error(
          'Linkwarden did not assign a new collection to the current user.',
        );
      }
      collections.push(current);
    }

    parentId = current.id;
  }

  // current is always set here (segments.length > 0).
  return current as LinkwardenCollection;
}

function applyImmediateDelta(state: SyncState, plan: SyncPlan): SyncState {
  const actionKeys = new Set(plan.actions.map((action) => action.stableKey));
  const items = { ...state.items };
  for (const key of plan.stateDelta.remove) {
    if (!actionKeys.has(key)) {
      delete items[key];
    }
  }
  for (const [key, delta] of Object.entries(plan.stateDelta.upsert)) {
    if (delta.commit === 'immediate') {
      items[key] = delta.item;
    }
  }
  return { ...state, items };
}

function applySuccessfulActionDelta(
  state: SyncState,
  plan: SyncPlan,
  action: SyncAction,
  result: LinkwardenLink | ChromeBookmarkResult | null,
): SyncState {
  const items = { ...state.items };
  const upsert = plan.stateDelta.upsert[action.stableKey];
  if (upsert !== undefined) {
    items[action.stableKey] = materializeUpsert(upsert, action, result);
  }
  if (plan.stateDelta.remove.includes(action.stableKey)) {
    delete items[action.stableKey];
  }
  return { ...state, items };
}

function materializeUpsert(
  upsert: StateUpsert,
  action: SyncAction,
  result: LinkwardenLink | ChromeBookmarkResult | null,
): SyncedItem {
  const item = { ...upsert.item };
  if (
    (action.type === 'createRemote' ||
      action.type === 'updateRemote' ||
      action.type === 'adoptRemote') &&
    isLinkwardenLink(result)
  ) {
    item.lwLinkId = result.id;
  }
  if (
    (action.type === 'createLocal' || action.type === 'updateLocal') &&
    isChromeBookmarkResult(result)
  ) {
    item.chromeId = result.chromeId;
  }
  return item;
}

interface ChromeBookmarkResult {
  chromeId: string;
}

function isLinkwardenLink(
  result: LinkwardenLink | ChromeBookmarkResult | null,
): result is LinkwardenLink {
  return result !== null && 'id' in result;
}

function isChromeBookmarkResult(
  result: LinkwardenLink | ChromeBookmarkResult | null,
): result is ChromeBookmarkResult {
  return result !== null && 'chromeId' in result;
}

function actionLog(action: SyncAction): SyncLogEntry {
  return {
    id: crypto.randomUUID(),
    at: Date.now(),
    type: action.type,
    reason: action.reason,
    status: 'ok',
  };
}

function emptyCounters(skipped: number): Omit<
  SyncStatus,
  'running' | 'lastSyncAt' | 'lastResult' | 'error'
> {
  return {
    createdRemote: 0,
    createdLocal: 0,
    updatedRemote: 0,
    updatedLocal: 0,
    deletedRemote: 0,
    deletedLocal: 0,
    skipped,
  };
}

function incrementCounter(
  counters: ReturnType<typeof emptyCounters>,
  actionType: SyncAction['type'],
): void {
  const mapping: Record<SyncAction['type'], keyof typeof counters> = {
    createRemote: 'createdRemote',
    createLocal: 'createdLocal',
    updateRemote: 'updatedRemote',
    updateLocal: 'updatedLocal',
    deleteRemote: 'deletedRemote',
    deleteLocal: 'deletedLocal',
    // Adoption is a remote metadata change (adding the tag).
    adoptRemote: 'updatedRemote',
  };
  counters[mapping[actionType]] += 1;
}

async function notifyBlocked(plan: SyncPlan): Promise<void> {
  await chrome.notifications.create({
    type: 'basic',
    iconUrl: NOTIFICATION_ICON,
    title: 'Syncwarden: sync held back',
    message: plan.blockReason ?? 'The sync plan was held back to be safe.',
  });
}
