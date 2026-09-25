import { describe, expect, it } from 'vitest';
import {
  BOOKMARK_DEBOUNCE_MINUTES,
  confirmTaskStarted,
} from '../src/entrypoints/background';
import {
  pollSyncUntilIdle,
  SyncPollTimeoutError,
} from '../src/entrypoints/popup/App';

interface TestDashboard {
  status: { running: boolean };
  revision: number;
}

describe('background lifecycle', () => {
  it('uses Chrome\'s production-safe minimum alarm delay', () => {
    expect(BOOKMARK_DEBOUNCE_MINUTES).toBe(0.5);
  });

  it('does not acknowledge a sync with the stale idle dashboard', async () => {
    let resolveTask: (() => void) | undefined;
    const task = new Promise<void>((resolve) => {
      resolveTask = resolve;
    });
    const dashboards: TestDashboard[] = [
      { status: { running: false }, revision: 1 },
      { status: { running: true }, revision: 2 },
    ];
    let readIndex = 0;

    const result = await confirmTaskStarted(
      task,
      async () => dashboards[Math.min(readIndex++, dashboards.length - 1)]!,
      { attempts: 2, delayMs: 0 },
    );

    expect(result).toEqual({ status: { running: true }, revision: 2 });
    resolveTask?.();
  });

  it('returns a terminal dashboard when a fast task already finished', async () => {
    const terminal = { status: { running: false }, revision: 3 };

    await expect(
      confirmTaskStarted(Promise.resolve(), async () => terminal, {
        attempts: 1,
        delayMs: 0,
      }),
    ).resolves.toBe(terminal);
  });

  it('propagates task startup failures', async () => {
    const failure = new Error('start failed');

    await expect(
      confirmTaskStarted(
        Promise.reject(failure),
        async () => ({ status: { running: false }, revision: 1 }),
        { attempts: 1, delayMs: 0 },
      ),
    ).rejects.toBe(failure);
  });

  it('keeps polling when a started task is slower than the handshake window', async () => {
    const task = new Promise<void>(() => undefined);
    const idle = { status: { running: false }, revision: 1 };

    await expect(
      confirmTaskStarted(task, async () => idle, {
        attempts: 1,
        delayMs: 0,
      }),
    ).resolves.toEqual({ status: { running: true }, revision: 1 });
  });
});

describe('popup sync polling', () => {
  it('waits until a running sync becomes idle', async () => {
    const dashboards: TestDashboard[] = [
      { status: { running: true }, revision: 1 },
      { status: { running: true }, revision: 2 },
      { status: { running: false }, revision: 3 },
    ];
    const updates: number[] = [];
    let readIndex = 0;

    const result = await pollSyncUntilIdle(
      async () => dashboards[Math.min(readIndex++, dashboards.length - 1)]!,
      (dashboard) => updates.push(dashboard.revision),
      { maxAttempts: 3, intervalMs: 0, wait: async () => undefined },
    );

    expect(result.revision).toBe(3);
    expect(updates).toEqual([1, 2, 3]);
  });

  it('throws with the live dashboard instead of reporting timeout as success', async () => {
    const running = { status: { running: true }, revision: 7 };

    const result = pollSyncUntilIdle(async () => running, undefined, {
      maxAttempts: 2,
      intervalMs: 0,
      wait: async () => undefined,
    });

    await expect(result).rejects.toMatchObject({
      name: 'SyncPollTimeoutError',
      dashboard: running,
    });
    await expect(result).rejects.toBeInstanceOf(SyncPollTimeoutError);
  });
});
