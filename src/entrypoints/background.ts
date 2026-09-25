import { defineBackground } from 'wxt/utils/define-background';
import { isBookmarkWriteGuardActive } from '../adapters/bookmarks';
import {
  approvePendingPlan,
  commitConnectionConfiguration,
  discardPendingPlan,
  getSyncDashboard,
  listSyncSnapshots,
  requestSync,
  restoreSnapshot,
  savePageToLinkwarden,
} from '../adapters/sync-runner';
import { normalizeBaseUrl } from '../adapters/linkwarden';
import {
  loadSyncJob,
  loadSyncPreferences,
  saveSyncPreferences,
  type SyncPreferences,
} from '../adapters/storage';

const SYNC_ALARM = 'syncwarden-periodic-sync';
// Separate alarm to debounce bookmark events: instead of syncing on every
// single add/delete (which starts lots of runs on bulk changes), we collect
// events and start one sync shortly after. An alarm rather than setTimeout so
// it survives a service worker restart.
const BOOKMARK_DEBOUNCE_ALARM = 'syncwarden-bookmark-debounce';
// Packed extensions can't fire alarms sooner than 30 seconds. Smaller values
// sometimes work in dev builds but get clamped or dropped in production.
export const BOOKMARK_DEBOUNCE_MINUTES = 0.5;
const START_CONFIRM_ATTEMPTS = 40;
const START_CONFIRM_DELAY_MS = 25;

export default defineBackground(() => {
  // This callback runs on every new service worker lifecycle, so interrupted
  // jobs resume after a normal idle restart too, not just after a full
  // browser restart.
  void initializeAndResume().catch((error: unknown) =>
    reportBackgroundError('startup', error),
  );

  chrome.runtime.onInstalled.addListener(() => {
    void initializeAndResume().catch((error: unknown) =>
      reportBackgroundError('startup after install', error),
    );
  });
  chrome.runtime.onStartup.addListener(() => {
    void initializeAndResume().catch((error: unknown) =>
      reportBackgroundError('startup on browser launch', error),
    );
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SYNC_ALARM) {
      void requestSync('alarm').catch((error: unknown) =>
        reportBackgroundError('scheduled sync', error),
      );
    } else if (alarm.name === BOOKMARK_DEBOUNCE_ALARM) {
      void triggerFromBookmarkEvent().catch((error: unknown) =>
        reportBackgroundError('bookmark sync', error),
      );
    }
  });

  const bookmarkEvent = () => {
    void scheduleBookmarkSync().catch((error: unknown) =>
      reportBackgroundError('bookmark alarm', error),
    );
  };
  chrome.bookmarks.onCreated.addListener(bookmarkEvent);
  chrome.bookmarks.onChanged.addListener(bookmarkEvent);
  chrome.bookmarks.onMoved.addListener(bookmarkEvent);
  chrome.bookmarks.onRemoved.addListener(bookmarkEvent);

  chrome.runtime.onMessage.addListener((message: unknown, _sender, respond) => {
    void handleMessage(message)
      .then((value) => respond({ ok: true, value }))
      .catch((error: unknown) =>
        respond({
          ok: false,
          error: error instanceof Error ? error.message : 'Unknown error.',
        }),
      );
    return true;
  });
});

let initialization: Promise<void> | null = null;

function initializeAndResume(): Promise<void> {
  if (initialization === null) {
    initialization = initializeBackground()
      .then(resumeInterruptedSync)
      .finally(() => {
        initialization = null;
      });
  }
  return initialization;
}

async function initializeBackground(): Promise<void> {
  const preferences = await loadSyncPreferences();
  await configureSyncAlarm(preferences.intervalMinutes);
}

async function resumeInterruptedSync(): Promise<void> {
  if ((await loadSyncJob()) !== null) {
    await requestSync('resume');
  }
}

async function triggerFromBookmarkEvent(): Promise<void> {
  await chrome.alarms.clear(BOOKMARK_DEBOUNCE_ALARM);
  if (await isBookmarkWriteGuardActive()) {
    // The event came from Syncwarden's own write, so no sync.
    return;
  }
  await requestSync('bookmark-event');
}

async function scheduleBookmarkSync(): Promise<void> {
  // While Syncwarden itself is writing, ignore events right away so we don't
  // start a sync against our own changes.
  if (await isBookmarkWriteGuardActive()) {
    return;
  }
  // (Re)start the debounce window: several events in a row lead to exactly
  // one sync run.
  await chrome.alarms.create(BOOKMARK_DEBOUNCE_ALARM, {
    delayInMinutes: BOOKMARK_DEBOUNCE_MINUTES,
  });
}

async function handleMessage(message: unknown): Promise<unknown> {
  if (!isRecord(message) || typeof message.type !== 'string') {
    throw new Error('Invalid extension message.');
  }
  if (message.type === 'sync:run') {
    // Don't wait for the whole sync, but only answer once the start is saved
    // or the run has already finished. That way the popup can't mistake an
    // old idle status for a successful run.
    return confirmTaskStarted(requestSync('manual'), getSyncDashboard);
  }
  if (message.type === 'sync:dashboard') {
    return getSyncDashboard();
  }
  if (message.type === 'plan:approve') {
    return confirmTaskStarted(approvePendingPlan(), getSyncDashboard);
  }
  if (message.type === 'plan:discard') {
    await discardPendingPlan();
    return getSyncDashboard();
  }
  if (message.type === 'snapshots:list') {
    return listSyncSnapshots();
  }
  if (message.type === 'snapshots:restore') {
    if (typeof message.id !== 'string') {
      throw new Error('Snapshot ID missing.');
    }
    await restoreSnapshot(message.id);
    return getSyncDashboard();
  }
  if (message.type === 'page:save') {
    if (typeof message.name !== 'string' || typeof message.url !== 'string') {
      throw new Error('Page title or URL missing.');
    }
    const url = new URL(message.url);
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      throw new Error('Only http(s) pages without embedded credentials are allowed.');
    }
    await savePageToLinkwarden({ name: message.name, url: message.url });
    return getSyncDashboard();
  }
  if (message.type === 'preferences:load') {
    return loadSyncPreferences();
  }
  if (message.type === 'preferences:save') {
    const preferences = parsePreferences(message.preferences);
    await saveSyncPreferences(preferences);
    await configureSyncAlarm(preferences.intervalMinutes);
    return preferences;
  }
  if (message.type === 'connection:commit') {
    const settings = parseConnectionSettings(message.settings);
    const preferences = parsePreferences(message.preferences);
    // Set up the alarm first: if the atomic storage write after it fails, the
    // old connection settings stay fully intact.
    await configureSyncAlarm(preferences.intervalMinutes);
    await commitConnectionConfiguration(settings, preferences);
    return preferences;
  }
  throw new Error(`Unknown message: ${message.type}`);
}

export async function confirmTaskStarted<T extends { status: { running: boolean } }>(
  task: Promise<void>,
  readStatus: () => Promise<T>,
  options: {
    attempts?: number;
    delayMs?: number;
  } = {},
): Promise<T> {
  let settled = false;
  let failed = false;
  let failure: unknown;
  void task.then(
    () => {
      settled = true;
    },
    (error: unknown) => {
      failed = true;
      failure = error;
      settled = true;
    },
  );

  const attempts = options.attempts ?? START_CONFIRM_ATTEMPTS;
  const delayMs = options.delayMs ?? START_CONFIRM_DELAY_MS;
  let latest = await readStatus();
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (latest.status.running) {
      return latest;
    }
    if (settled) {
      if (failed) {
        throw failure;
      }
      return latest;
    }
    await delay(delayMs);
    latest = await readStatus();
  }
  // The task promise is still pending, so it was started in this worker. A
  // synthetic running=true keeps the popup polling instead of treating a
  // task that is still running as failed.
  return {
    ...latest,
    status: { ...latest.status, running: true },
  };
}

async function configureSyncAlarm(intervalMinutes: number): Promise<void> {
  const existing = await chrome.alarms.get(SYNC_ALARM);
  if (existing?.periodInMinutes === intervalMinutes) {
    return;
  }
  await chrome.alarms.clear(SYNC_ALARM);
  await chrome.alarms.create(SYNC_ALARM, {
    delayInMinutes: intervalMinutes,
    periodInMinutes: intervalMinutes,
  });
}

function parseConnectionSettings(value: unknown): {
  baseUrl: string;
  token: string;
} {
  if (!isRecord(value) || typeof value.baseUrl !== 'string') {
    throw new Error('Linkwarden connection settings are missing.');
  }
  if (typeof value.token !== 'string' || value.token.trim().length === 0) {
    throw new Error('Access token missing.');
  }
  return {
    baseUrl: normalizeBaseUrl(value.baseUrl),
    token: value.token.trim(),
  };
}

function parsePreferences(value: unknown): SyncPreferences {
  if (!isRecord(value)) {
    throw new Error('Sync settings are missing.');
  }
  const mode = value.mode;
  const intervalMinutes = value.intervalMinutes;
  const dryRun = value.dryRun;
  if (
    mode !== 'additive-up' &&
    mode !== 'additive-both' &&
    mode !== 'bidirectional'
  ) {
    throw new Error('Unknown sync mode.');
  }
  if (
    typeof intervalMinutes !== 'number' ||
    intervalMinutes < 5 ||
    intervalMinutes > 120
  ) {
    throw new Error('The interval must be between 5 and 120 minutes.');
  }
  return {
    mode,
    intervalMinutes,
    dryRun: typeof dryRun === 'boolean' ? dryRun : false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reportBackgroundError(context: string, error: unknown): void {
  const message =
    error instanceof Error ? error.message : 'Unknown background error.';
  console.error(`[Syncwarden] ${context}: ${message}`, error);
}
