import { FormEvent, useEffect, useRef, useState } from 'react';
import {
  LinkwardenClient,
  normalizeBaseUrl,
  permissionOrigin,
} from '../../adapters/linkwarden';
import {
  EMPTY_SYNC_STATUS,
  type LinkwardenSettings,
  type PendingPlan,
  type SyncLogEntry,
  type SyncPreferences,
  type SyncStatus,
  loadLinkwardenSettings,
  loadSyncPreferences,
} from '../../adapters/storage';
import type { SyncAction, SyncMode } from '../../core/types';

type Screen = 'status' | 'log' | 'settings';
type Feedback = {
  kind: 'idle' | 'success' | 'error';
  message: string;
};

interface SnapshotSummary {
  id: string;
  createdAt: number;
  reason: string;
}

interface Dashboard {
  status: SyncStatus;
  log: SyncLogEntry[];
  pending: PendingPlan | null;
}

interface MessageResponse<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

const INITIAL_FEEDBACK: Feedback = {
  kind: 'idle',
  message: 'Ready to sync.',
};

const MODE_OPTIONS: Array<{
  value: SyncMode;
  label: string;
  hint: string;
}> = [
  {
    value: 'additive-up',
    label: 'Upload only',
    hint: 'Local bookmarks go to Linkwarden automatically. Nothing is deleted.',
  },
  {
    value: 'additive-both',
    label: 'Additive',
    hint: 'Create in both directions, mirrored under “Linkwarden/”. Nothing is deleted.',
  },
  {
    value: 'bidirectional',
    label: 'Two-way (full auto sync)',
    hint: 'Additions and deletions sync both ways. Browser changes are picked up right away, Linkwarden is polled on an interval. Mass deletions ask first.',
  },
];

export function App() {
  const [screen, setScreen] = useState<Screen>('status');
  const [baseUrl, setBaseUrl] = useState('');
  const [token, setToken] = useState('');
  const [settings, setSettings] = useState<LinkwardenSettings | null>(null);
  const [preferences, setPreferences] = useState<SyncPreferences>({
    mode: 'additive-up',
    intervalMinutes: 15,
    dryRun: false,
  });
  const [dashboard, setDashboard] = useState<Dashboard>({
    status: EMPTY_SYNC_STATUS,
    log: [],
    pending: null,
  });
  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isSavingPage, setIsSavingPage] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [isSavingPreferences, setIsSavingPreferences] = useState(false);
  const [isInitializing, setIsInitializing] = useState(true);
  const [feedback, setFeedback] = useState<Feedback>(INITIAL_FEEDBACK);
  const isSyncingRef = useRef(false);
  const isConnectingRef = useRef(false);
  const preferencesRef = useRef(preferences);
  const preferenceRevisionRef = useRef(0);
  const preferenceSaveErrorRef = useRef<unknown>(null);
  const preferenceSaveQueueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    void initializePopup();

    async function initializePopup(): Promise<void> {
      const [settingsResult, preferencesResult, dashboardResult, snapshotsResult] =
        await Promise.allSettled([
          loadLinkwardenSettings(),
          loadSyncPreferences(),
          sendMessage<Dashboard>({ type: 'sync:dashboard' }),
          sendMessage<SnapshotSummary[]>({ type: 'snapshots:list' }),
        ]);

      if (settingsResult.status === 'fulfilled' && settingsResult.value !== null) {
        setSettings(settingsResult.value);
        setBaseUrl(settingsResult.value.baseUrl);
        setToken(settingsResult.value.token);
      }
      if (preferencesResult.status === 'fulfilled') {
        preferencesRef.current = preferencesResult.value;
        setPreferences(preferencesResult.value);
      }
      if (snapshotsResult.status === 'fulfilled') {
        setSnapshots(snapshotsResult.value);
      }
      if (dashboardResult.status === 'fulfilled') {
        const storedDashboard = dashboardResult.value;
        setDashboard(storedDashboard);
        if (storedDashboard.status.running) {
          isSyncingRef.current = true;
          setIsSyncing(true);
          void pollSyncUntilIdle(
            () => sendMessage<Dashboard>({ type: 'sync:dashboard' }),
            setDashboard,
          )
            .then((final) => {
              setDashboard(final);
              void refreshSnapshots();
            })
            .catch((error: unknown) => {
              if (!handlePollingError(error)) {
                showError(error, 'Could not refresh the live status.');
                void refreshDashboard();
              }
            })
            .finally(() => {
              isSyncingRef.current = false;
              setIsSyncing(false);
            });
        }
      }

      const requiredFailure = [
        settingsResult,
        preferencesResult,
        dashboardResult,
      ].find((result) => result.status === 'rejected');
      if (requiredFailure?.status === 'rejected') {
        showError(
          requiredFailure.reason,
          'Syncwarden could not finish starting up.',
        );
      }
      setIsInitializing(false);
    }
  }, []);

  async function refreshSnapshots() {
    try {
      setSnapshots(await sendMessage<SnapshotSummary[]>({ type: 'snapshots:list' }));
    } catch {
      // Snapshots are optional extra info; errors stay in the log.
    }
  }

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isConnectingRef.current) return;
    if (isInitializing || isSyncingRef.current || dashboard.status.running) {
      setFeedback({
        kind: 'idle',
        message:
          'Starting up or syncing. Save the connection again afterwards.',
      });
      return;
    }
    isConnectingRef.current = true;
    setIsConnecting(true);
    setFeedback({ kind: 'idle', message: 'Checking connection …' });
    try {
      await flushPreferenceSaves();
      const normalizedUrl = normalizeBaseUrl(baseUrl);
      const origin = permissionOrigin(normalizedUrl);
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) {
        throw new Error(
          'Host access not granted. Allow access to your Linkwarden instance.',
        );
      }
      const nextSettings = { baseUrl: normalizedUrl, token: token.trim() };
      if (nextSettings.token.length === 0) {
        throw new Error(
          'Access token missing. Create one in the Linkwarden settings.',
        );
      }
      const collections = await new LinkwardenClient(nextSettings).testConnection();
      const savedPreferences = await sendMessage<SyncPreferences>({
        type: 'connection:commit',
        settings: nextSettings,
        preferences: preferencesRef.current,
      });
      const previousOrigin =
        settings === null ? null : permissionOrigin(settings.baseUrl);
      let permissionWarning = false;
      if (previousOrigin !== null && previousOrigin !== origin) {
        try {
          await chrome.permissions.remove({ origins: [previousOrigin] });
        } catch {
          permissionWarning = true;
        }
      }
      setSettings(nextSettings);
      preferencesRef.current = savedPreferences;
      setPreferences(savedPreferences);
      setBaseUrl(nextSettings.baseUrl);
      setToken(nextSettings.token);
      await refreshDashboard();
      setFeedback({
        kind: 'success',
        message:
          `Connected. Found ${collections.length} collections.` +
          (permissionWarning
            ? ' The old host permission could not be removed automatically.'
            : ''),
      });
    } catch (error) {
      showError(error, 'Connection failed. Check URL and token.');
    } finally {
      isConnectingRef.current = false;
      setIsConnecting(false);
    }
  }

  async function savePreferences(next: SyncPreferences) {
    const revision = preferenceRevisionRef.current + 1;
    preferenceRevisionRef.current = revision;
    preferencesRef.current = next;
    setPreferences(next);
    setIsSavingPreferences(true);
    try {
      const saved = await persistPreferences(next);
      if (preferenceRevisionRef.current === revision) {
        preferencesRef.current = saved;
        setPreferences(saved);
        setFeedback({ kind: 'success', message: 'Settings saved.' });
      }
    } catch (error) {
      if (preferenceRevisionRef.current === revision) {
        showError(error, 'Could not save settings.');
      }
    } finally {
      if (preferenceRevisionRef.current === revision) {
        setIsSavingPreferences(false);
      }
    }
  }

  function persistPreferences(next: SyncPreferences): Promise<SyncPreferences> {
    const operation = preferenceSaveQueueRef.current.then(() =>
      sendMessage<SyncPreferences>({
        type: 'preferences:save',
        preferences: next,
      }),
    );
    preferenceSaveQueueRef.current = operation.then(
      () => {
        preferenceSaveErrorRef.current = null;
      },
      (error: unknown) => {
        preferenceSaveErrorRef.current = error;
      },
    );
    return operation;
  }

  async function flushPreferenceSaves(): Promise<void> {
    // New changes can be queued while we await. Only return once we really
    // reached the current end of the queue.
    while (true) {
      const pending = preferenceSaveQueueRef.current;
      await pending;
      if (pending === preferenceSaveQueueRef.current) break;
    }
    if (preferenceSaveErrorRef.current !== null) {
      throw preferenceSaveErrorRef.current;
    }
  }

  async function synchronize() {
    if (isSyncingRef.current) return;
    if (isConnectingRef.current) {
      setFeedback({
        kind: 'idle',
        message: 'Still saving the connection settings …',
      });
      return;
    }
    isSyncingRef.current = true;
    setIsSyncing(true);
    setFeedback({ kind: 'idle', message: 'Syncing …' });
    try {
      await flushPreferenceSaves();
      // The background confirms a persisted start, or returns a quick run that
      // has already finished.
      const started = await sendMessage<Dashboard>({ type: 'sync:run' });
      setDashboard(started);
      const final = started.status.running
        ? await pollSyncUntilIdle(
            () => sendMessage<Dashboard>({ type: 'sync:dashboard' }),
            setDashboard,
          )
        : started;
      setDashboard(final);
      await refreshSnapshots();
      if (final.pending !== null) {
        setFeedback({
          kind: 'error',
          message: 'Sync held back. Review the planned deletions.',
        });
      } else if (final.status.lastResult === 'error') {
        setFeedback({
          kind: 'error',
          message: final.status.error ?? 'Sync failed. Check the log.',
        });
      } else if (preferencesRef.current.dryRun) {
        setFeedback({ kind: 'success', message: 'Dry run finished. Nothing was written.' });
      } else {
        setFeedback({ kind: 'success', message: summarizeRun(final.status) });
      }
    } catch (error) {
      if (!handlePollingError(error)) {
        showError(error, 'Sync failed. Check the log.');
        await refreshDashboard();
      }
    } finally {
      isSyncingRef.current = false;
      setIsSyncing(false);
    }
  }

  function handlePollingError(error: unknown): boolean {
    if (error instanceof SyncPollTimeoutError) {
      setDashboard(error.dashboard as Dashboard);
      setFeedback({
        kind: 'idle',
        message: 'Sync keeps running in the background. Reopen the popup later.',
      });
      return true;
    }
    return false;
  }

  async function refreshDashboard() {
    try {
      setDashboard(await sendMessage<Dashboard>({ type: 'sync:dashboard' }));
    } catch {
      // Dashboard keeps the last known state.
    }
  }

  async function approvePlan() {
    if (isBusy) return;
    setIsBusy(true);
    setFeedback({ kind: 'idle', message: 'Running the approved plan …' });
    try {
      const started = await sendMessage<Dashboard>({ type: 'plan:approve' });
      setDashboard(started);
      const final = started.status.running
        ? await pollSyncUntilIdle(
            () => sendMessage<Dashboard>({ type: 'sync:dashboard' }),
            setDashboard,
          )
        : started;
      setDashboard(final);
      await refreshSnapshots();
      if (final.pending !== null) {
        setFeedback({
          kind: 'error',
          message:
            final.status.error ??
            'Bookmarks changed in the meantime. Review the new plan.',
        });
      } else if (final.status.lastResult === 'error') {
        setFeedback({
          kind: 'error',
          message: final.status.error ?? 'Could not run the plan.',
        });
      } else {
        setFeedback({ kind: 'success', message: summarizeRun(final.status) });
      }
    } catch (error) {
      if (!handlePollingError(error)) {
        showError(error, 'Could not run the plan.');
        await refreshDashboard();
      }
    } finally {
      setIsBusy(false);
    }
  }

  async function discardPlan() {
    if (isBusy) return;
    setIsBusy(true);
    try {
      const next = await sendMessage<Dashboard>({ type: 'plan:discard' });
      setDashboard(next);
      setFeedback({ kind: 'success', message: 'Plan discarded.' });
    } catch (error) {
      showError(error, 'Could not discard the plan.');
    } finally {
      setIsBusy(false);
    }
  }

  async function restore(id: string) {
    if (isBusy) return;
    const selected = snapshots.find((snapshot) => snapshot.id === id);
    const timestamp =
      selected === undefined
        ? 'the selected point in time'
        : new Date(selected.createdAt).toLocaleString();
    if (
      !window.confirm(
        `Reset the local browser bookmarks to ${timestamp}? A backup of the current state is made first. Linkwarden itself is not reset.`,
      )
    ) {
      return;
    }
    setIsBusy(true);
    setFeedback({ kind: 'idle', message: 'Restoring snapshot …' });
    try {
      const next = await sendMessage<Dashboard>({ type: 'snapshots:restore', id });
      setDashboard(next);
      await refreshSnapshots();
      setFeedback({ kind: 'success', message: 'Bookmarks restored.' });
    } catch (error) {
      showError(error, 'Restore failed.');
    } finally {
      setIsBusy(false);
    }
  }

  async function saveActivePage() {
    if (isSavingPage) return;
    if (isInitializing || isSyncingRef.current || dashboard.status.running) {
      setFeedback({
        kind: 'idle',
        message: 'Sync in progress. Save the page again afterwards.',
      });
      return;
    }
    if (settings === null) {
      setScreen('settings');
      setFeedback({
        kind: 'error',
        message: 'Linkwarden is not connected. Save URL and token first.',
      });
      return;
    }
    setIsSavingPage(true);
    setFeedback({ kind: 'idle', message: 'Saving page …' });
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const activeTab = tabs[0];
      if (activeTab?.url === undefined) {
        throw new Error(
          'The active tab has no URL. Open a normal web page.',
        );
      }
      const url = new URL(activeTab.url);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new Error(
          'This page can’t be saved. Open an http or https page.',
        );
      }
      await sendMessage<Dashboard>({
        type: 'page:save',
        name: activeTab.title?.trim() || url.hostname,
        url: url.href,
      });
      setFeedback({ kind: 'success', message: 'Page saved.' });
    } catch (error) {
      showError(error, 'Could not save the page.');
    } finally {
      setIsSavingPage(false);
    }
  }

  function showError(error: unknown, fallback: string) {
    setFeedback({
      kind: 'error',
      message: error instanceof Error ? error.message : fallback,
    });
  }

  const pending = dashboard.pending;

  return (
    <main className="relative h-[600px] overflow-hidden px-4 py-4 text-white">
      <section className="relative z-10 flex h-full flex-col">
        <header className="mb-3 flex items-center justify-between px-1">
          <h1 className="text-[26px] font-semibold tracking-[-0.035em]">
            Syncwarden
          </h1>
          <span
            className={`status-dot status-${
              dashboard.status.running ? 'running' : (dashboard.status.lastResult ?? 'idle')
            }`}
          >
            {dashboard.status.running ? 'Running' : modeLabel(preferences.mode)}
          </span>
        </header>

        {pending !== null ? (
          <BlockedScreen
            pending={pending}
            isBusy={
              isBusy || isInitializing || isSyncing || dashboard.status.running
            }
            onApprove={() => void approvePlan()}
            onDiscard={() => void discardPlan()}
          />
        ) : (
          <>
            <nav className="glass-nav mb-3 grid grid-cols-3" aria-label="Sections">
              {(['status', 'log', 'settings'] as const).map((item) => (
                <button
                  key={item}
                  className={screen === item ? 'nav-button nav-button-active' : 'nav-button'}
                  type="button"
                  onClick={() => setScreen(item)}
                >
                  {item === 'status' ? 'Status' : item === 'log' ? 'Log' : 'Settings'}
                </button>
              ))}
            </nav>

            <div className="min-h-0 flex-1 overflow-y-auto pr-0.5">
              {screen === 'status' && (
                <StatusScreen
                  status={dashboard.status}
                  dryRun={preferences.dryRun}
                  isSyncing={
                    isSyncing || dashboard.status.running || isInitializing
                  }
                  isSavingPage={isSavingPage}
                  isPageLocked={
                    isInitializing || isSyncing || dashboard.status.running
                  }
                  onSync={() => void synchronize()}
                  onSavePage={() => void saveActivePage()}
                />
              )}
              {screen === 'log' && <LogScreen entries={dashboard.log} />}
              {screen === 'settings' && (
                <SettingsScreen
                  baseUrl={baseUrl}
                  token={token}
                  preferences={preferences}
                  snapshots={snapshots}
                  isConnecting={isConnecting}
                  isBusy={
                    isBusy ||
                    isInitializing ||
                    isSyncing ||
                    dashboard.status.running
                  }
                  isSavingPreferences={isSavingPreferences || isConnecting}
                  onBaseUrl={setBaseUrl}
                  onToken={setToken}
                  onPreferences={(next) => void savePreferences(next)}
                  onSubmit={connect}
                  onRestore={(id) => void restore(id)}
                />
              )}
            </div>
          </>
        )}

        <div
          className={`feedback mt-3 feedback-${feedback.kind}`}
          role={feedback.kind === 'error' ? 'alert' : 'status'}
          aria-live="polite"
        >
          {feedback.message}
        </div>
      </section>
    </main>
  );
}

export class SyncPollTimeoutError<T> extends Error {
  constructor(public readonly dashboard: T) {
    super('Sync is still running after status polling timed out.');
    this.name = 'SyncPollTimeoutError';
  }
}

export async function pollSyncUntilIdle<
  T extends { status: { running: boolean } },
>(
  readDashboard: () => Promise<T>,
  onUpdate: (dashboard: T) => void = () => undefined,
  options: {
    maxAttempts?: number;
    intervalMs?: number;
    wait?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 120;
  const intervalMs = options.intervalMs ?? 1000;
  const wait = options.wait ?? delay;
  if (maxAttempts < 1) {
    throw new Error('Status polling needs at least one attempt.');
  }

  let latest = await readDashboard();
  onUpdate(latest);
  for (let attempt = 1; attempt < maxAttempts; attempt += 1) {
    if (!latest.status.running) {
      return latest;
    }
    await wait(intervalMs);
    latest = await readDashboard();
    onUpdate(latest);
  }
  if (!latest.status.running) {
    return latest;
  }
  throw new SyncPollTimeoutError(latest);
}

function StatusScreen(props: {
  status: SyncStatus;
  dryRun: boolean;
  isSyncing: boolean;
  isSavingPage: boolean;
  isPageLocked: boolean;
  onSync: () => void;
  onSavePage: () => void;
}) {
  const changed =
    props.status.createdRemote +
    props.status.createdLocal +
    props.status.updatedRemote +
    props.status.updatedLocal +
    props.status.deletedRemote +
    props.status.deletedLocal;
  const running = props.status.running || props.isSyncing;
  return (
    <div>
      {running && (
        <section className="glass-card mb-3 flex items-center gap-3 p-4">
          <span className="sync-spinner" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-[14px] font-semibold">Syncing …</p>
            <p className="truncate text-[12px] text-white/55">
              {changed > 0
                ? `${changed} changes applied so far`
                : 'Comparing local and remote bookmarks'}
            </p>
          </div>
        </section>
      )}

      <section className="glass-card mb-3 p-4">
        <p className="eyebrow">Last sync</p>
        <div className="mt-1 flex items-end justify-between">
          <strong className="text-[20px] font-semibold">
            {formatDate(props.status.lastSyncAt)}
          </strong>
          <span className="text-[13px] text-white/55">{changed} changes</span>
        </div>
        {props.status.error !== null && (
          <p className="text-error mt-2 text-[13px] leading-5">
            {props.status.error}
          </p>
        )}
      </section>

      <section className="glass-card mb-3 grid grid-cols-3 divide-x divide-[#262626]">
        <Metric label="Created" value={props.status.createdRemote + props.status.createdLocal} />
        <Metric label="Updated" value={props.status.updatedRemote + props.status.updatedLocal} />
        <Metric label="Deleted" value={props.status.deletedRemote + props.status.deletedLocal} />
      </section>

      {props.dryRun && (
        <p className="mb-2 rounded-[12px] border border-white/15 px-3 py-2 text-[12px] text-white/60">
          Dry run is on: the sync plans actions but writes nothing.
        </p>
      )}

      <button
        className="primary-button mb-2 w-full"
        type="button"
        disabled={props.isSyncing}
        onClick={props.onSync}
      >
        {props.isSyncing ? 'Syncing …' : 'Sync now'}
      </button>
      <button
        className="secondary-button w-full"
        type="button"
        disabled={props.isSavingPage || props.isPageLocked}
        onClick={props.onSavePage}
      >
        {props.isSavingPage ? 'Saving …' : 'Save this page'}
      </button>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="px-3 py-3 text-center">
      <strong className="block text-[20px] tabular-nums">{value}</strong>
      <span className="text-[11px] text-white/55">{label}</span>
    </div>
  );
}

function LogScreen({ entries }: { entries: SyncLogEntry[] }) {
  if (entries.length === 0) {
    return (
      <div className="glass-card p-5 text-center text-[13px] leading-5 text-white/55">
        Run a sync to see the first actions here.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {entries.map((entry) => (
        <article key={entry.id} className={`glass-row px-3 py-2.5 log-${entry.status}`}>
          <div className="flex items-center justify-between gap-3">
            <strong className="truncate text-[13px]">{logLabel(entry.type)}</strong>
            <time className="text-[11px] tabular-nums text-white/45">
              {new Date(entry.at).toLocaleTimeString(undefined, {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              })}
            </time>
          </div>
          <p className="mt-1 text-[11px] leading-4 text-white/55">{entry.reason}</p>
        </article>
      ))}
    </div>
  );
}

function BlockedScreen(props: {
  pending: PendingPlan;
  isBusy: boolean;
  onApprove: () => void;
  onDiscard: () => void;
}) {
  const actions = props.pending.job.plan?.actions ?? [];
  const deletions = actions.filter(
    (action) => action.type === 'deleteRemote' || action.type === 'deleteLocal',
  );
  return (
    <div className="min-h-0 flex-1 overflow-y-auto pr-0.5">
      <section className="glass-thick-card mb-3 p-4">
        <p className="eyebrow text-error">Sync held back</p>
        <p className="mt-2 text-[13px] leading-5 text-white/80">
          {props.pending.blockReason}
        </p>
        <p className="mt-2 text-[11px] text-white/50">
          {deletions.length} of {actions.length} planned actions delete something.
          Check every line before you approve.
        </p>
      </section>

      <div className="mb-3 space-y-1.5">
        {actions.map((action, index) => (
          <ActionRow key={`${action.stableKey}-${index}`} action={action} />
        ))}
      </div>

      <button
        className="danger-button mb-2 w-full"
        type="button"
        disabled={props.isBusy}
        onClick={props.onApprove}
      >
        {props.isBusy ? 'Running …' : 'Run plan'}
      </button>
      <button
        className="secondary-button w-full"
        type="button"
        disabled={props.isBusy}
        onClick={props.onDiscard}
      >
        Discard
      </button>
    </div>
  );
}

function ActionRow({ action }: { action: SyncAction }) {
  const isDelete = action.type === 'deleteRemote' || action.type === 'deleteLocal';
  return (
    <article className={`glass-row px-3 py-2 ${isDelete ? 'action-delete' : ''}`}>
      <div className="flex items-center justify-between gap-2">
        <strong className={`text-[12px] font-semibold ${isDelete ? 'text-error' : ''}`}>
          {actionLabel(action.type)}
        </strong>
        <span className="text-[11px] text-white/45">{action.reason}</span>
      </div>
      <p className="mt-0.5 truncate text-[13px]">{describeTarget(action)}</p>
    </article>
  );
}

function SettingsScreen(props: {
  baseUrl: string;
  token: string;
  preferences: SyncPreferences;
  snapshots: SnapshotSummary[];
  isConnecting: boolean;
  isBusy: boolean;
  isSavingPreferences: boolean;
  onBaseUrl: (value: string) => void;
  onToken: (value: string) => void;
  onPreferences: (value: SyncPreferences) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onRestore: (id: string) => void;
}) {
  function selectMode(mode: SyncMode) {
    if (mode === 'bidirectional' && props.preferences.mode !== 'bidirectional') {
      const confirmed = window.confirm(
        'Turn on two-way sync?\n\nDeletions are synced in both directions. ' +
          'Large batches of deletions are held back for manual approval, ' +
          'but bookmarks deleted locally can be removed from Linkwarden.',
      );
      if (!confirmed) return;
    }
    props.onPreferences({ ...props.preferences, mode });
  }

  return (
    <div className="space-y-3">
      <form className="glass-card p-4" onSubmit={(event) => void props.onSubmit(event)}>
        <p className="eyebrow">Connection</p>
        <label className="field-label mt-3" htmlFor="base-url">Base URL</label>
        <input
          id="base-url"
          className="glass-input mb-3"
          type="url"
          autoComplete="url"
          placeholder="https://linkwarden.example"
          value={props.baseUrl}
          disabled={props.isBusy || props.isConnecting}
          required
          onChange={(event) => props.onBaseUrl(event.target.value)}
        />
        <label className="field-label" htmlFor="access-token">Access token</label>
        <input
          id="access-token"
          className="glass-input mb-3"
          type="password"
          autoComplete="off"
          placeholder="Paste token"
          value={props.token}
          disabled={props.isBusy || props.isConnecting}
          required
          onChange={(event) => props.onToken(event.target.value)}
        />
        <button
          className="secondary-button w-full"
          type="submit"
          disabled={props.isConnecting || props.isBusy}
        >
          {props.isConnecting ? 'Checking connection …' : 'Test connection'}
        </button>
      </form>

      <section className="glass-card p-4">
        <p className="eyebrow">Mode</p>
        <div className="mt-2 space-y-1.5">
          {MODE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={
                props.preferences.mode === option.value
                  ? 'mode-option mode-option-active'
                  : 'mode-option'
              }
              disabled={props.isSavingPreferences || props.isBusy}
              onClick={() => selectMode(option.value)}
            >
              <span className="text-[13px] font-semibold">{option.label}</span>
              <span className="mt-0.5 block text-[11px] leading-4 text-white/55">
                {option.hint}
              </span>
            </button>
          ))}
        </div>

        <label className="field-label mt-4" htmlFor="interval">Interval in minutes</label>
        <input
          id="interval"
          className="glass-input mb-3"
          type="number"
          min={5}
          max={120}
          value={props.preferences.intervalMinutes}
          disabled={props.isSavingPreferences || props.isBusy}
          onChange={(event) =>
            props.onPreferences({
              ...props.preferences,
              intervalMinutes: clampInterval(Number(event.target.value)),
            })
          }
        />

        <label className="glass-row flex items-center justify-between px-3 py-2.5">
          <span className="text-[13px]">Dry run</span>
          <input
            type="checkbox"
            className="h-5 w-5 accent-[#5ac8fa]"
            checked={props.preferences.dryRun}
            disabled={props.isSavingPreferences || props.isBusy}
            onChange={(event) =>
              props.onPreferences({ ...props.preferences, dryRun: event.target.checked })
            }
          />
        </label>
      </section>

      <section className="glass-card p-4">
        <p className="eyebrow">Restore snapshots</p>
        {props.snapshots.length === 0 ? (
          <p className="mt-2 text-[11px] leading-4 text-white/55">
            A snapshot is taken automatically before every write.
          </p>
        ) : (
          <div className="mt-2 space-y-1.5">
            {props.snapshots.map((snapshot) => (
              <div
                key={snapshot.id}
                className="glass-row flex items-center justify-between gap-2 px-3 py-2"
              >
                <div className="min-w-0">
                  <strong className="block truncate text-[13px]">{snapshot.reason}</strong>
                  <span className="text-[11px] tabular-nums text-white/45">
                    {new Date(snapshot.createdAt).toLocaleString(undefined, {
                      day: '2-digit',
                      month: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
                <button
                  type="button"
                  className="secondary-button shrink-0 px-3 !min-h-9 text-[13px]"
                  disabled={props.isBusy}
                  onClick={() => props.onRestore(snapshot.id)}
                >
                  Restore
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

async function sendMessage<T>(message: Record<string, unknown>): Promise<T> {
  const response = (await chrome.runtime.sendMessage(message)) as MessageResponse<T>;
  if (!response.ok || response.value === undefined) {
    throw new Error(response.error ?? 'The service worker is not responding.');
  }
  return response.value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeRun(status: SyncStatus): string {
  const parts: string[] = [];
  const created = status.createdRemote + status.createdLocal;
  const updated = status.updatedRemote + status.updatedLocal;
  const deleted = status.deletedRemote + status.deletedLocal;
  if (created > 0) parts.push(`${created} new`);
  if (updated > 0) parts.push(`${updated} updated`);
  if (deleted > 0) parts.push(`${deleted} deleted`);
  if (status.skipped > 0) parts.push(`${status.skipped} skipped`);
  return parts.length === 0
    ? 'Synced. No changes.'
    : `Synced: ${parts.join(', ')}.`;
}

function clampInterval(value: number): number {
  if (Number.isNaN(value)) return 15;
  return Math.min(120, Math.max(5, Math.round(value)));
}

function modeLabel(mode: SyncMode): string {
  return mode === 'additive-up'
    ? 'Upload only'
    : mode === 'additive-both'
      ? 'Additive'
      : 'Two-way';
}

function actionLabel(type: SyncAction['type']): string {
  switch (type) {
    case 'createRemote':
      return 'Create remote';
    case 'createLocal':
      return 'Create local';
    case 'updateRemote':
      return 'Update remote';
    case 'updateLocal':
      return 'Update local';
    case 'deleteRemote':
      return 'Delete remote';
    case 'deleteLocal':
      return 'Delete local';
    case 'adoptRemote':
      return 'Adopt remote';
    default:
      return type;
  }
}

const LOG_LABELS: Record<string, string> = {
  blocked: 'Plan held back',
  dryRun: 'Dry run',
  planApproved: 'Plan approved',
  planChanged: 'Plan changed',
  planDiscarded: 'Plan discarded',
  replan: 'Planned again',
  restore: 'Snapshot restored',
  skipLocal: 'Skipped local',
  skipRemote: 'Skipped remote',
  syncError: 'Sync failed',
};

function logLabel(type: string): string {
  return LOG_LABELS[type] ?? actionLabel(type as SyncAction['type']);
}

function describeTarget(action: SyncAction): string {
  switch (action.type) {
    case 'createRemote':
    case 'deleteLocal':
      return action.payload.local.title || action.payload.local.url;
    case 'createLocal':
    case 'deleteRemote':
      return action.payload.remote.title || action.payload.remote.url;
    case 'updateRemote':
    case 'updateLocal':
    case 'adoptRemote':
      return action.payload.local.title || action.payload.remote.title;
  }
}

function formatDate(value: number | null): string {
  if (value === null) return 'Never synced';
  return new Date(value).toLocaleString(undefined, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
