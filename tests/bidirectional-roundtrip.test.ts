import { describe, expect, it } from 'vitest';
import { buildPlan } from '../src/core/sync-engine';
import { createLocalItem, createRemoteItem } from '../src/core/keys';
import { remotePathToLocalPath } from '../src/core/paths';
import type { SyncState } from '../src/core/types';

const EMPTY: SyncState = {
  schemaVersion: 1,
  items: {},
  folders: {},
  lastSyncAt: null,
  lastResult: null,
};

// canonicalFolderPath aus bookmarks.ts nachgebildet (localMirrorPathToRemotePath ?? local)
import { localMirrorPathToRemotePath } from '../src/core/paths';
function canonical(local: string): string {
  return localMirrorPathToRemotePath(local) ?? local;
}

describe('bidirectional roundtrip stability', () => {
  it('A: remote link downloaded then re-scanned locally produces NO further action', async () => {
    // 1. Remote-Link in Collection "Dev"
    const remote = await createRemoteItem({
      lwLinkId: 10,
      url: 'https://example.com/a',
      title: 'A',
      folderPath: 'Dev',
      tags: ['browser-sync'],
    });

    // 2. Erster Sync (bidirectional): createLocal
    const plan1 = buildPlan([], [remote], EMPTY, 'bidirectional', 1000);
    expect(plan1.actions.map((a) => a.type)).toEqual(['createLocal']);
    expect(plan1.blocked).toBe(false);

    // 3. Simuliere: Bookmark liegt jetzt lokal unter Mirror-Root
    const localPath = remotePathToLocalPath('Dev'); // Bookmarks Bar/Dev
    const local = await createLocalItem({
      chromeId: 'c1',
      url: 'https://example.com/a',
      title: 'A',
      folderPath: canonical(localPath), // wie walk() es meldet -> "Dev"
    });

    // 4. State after the first sync
    const state: SyncState = {
      ...EMPTY,
      items: {
        [remote.stableKey]: {
          stableKey: remote.stableKey,
          chromeId: 'c1',
          lwLinkId: 10,
          url: remote.url,
          title: 'A',
          folderPath: 'Dev',
          contentHash: remote.contentHash,
          lastSyncedAt: 1000,
        },
      },
    };

    // 5. Second sync: local + remote identical -> NO action (no loop!)
    const plan2 = buildPlan([local], [remote], state, 'bidirectional', 2000);
    expect(plan2.actions).toEqual([]);
    expect(local.contentHash).toBe(remote.contentHash);
    expect(local.stableKey).toBe(remote.stableKey);
  });

  it('B: native bookmark uploaded then re-scanned produces NO further action', async () => {
    const local = await createLocalItem({
      chromeId: 'c2',
      url: 'https://example.com/b',
      title: 'B',
      // Below the bookmarks bar -> collection "Work".
      folderPath: canonical('Bookmarks Bar/Work'),
    });
    expect(local.folderPath).toBe('Work');

    const plan1 = buildPlan([local], [], EMPTY, 'bidirectional', 1000);
    expect(plan1.actions.map((a) => a.type)).toEqual(['createRemote']);

    // Remote link as it comes back after upload: collection path = "Work".
    const remote = await createRemoteItem({
      lwLinkId: 20,
      url: 'https://example.com/b',
      title: 'B',
      folderPath: 'Work',
      tags: ['browser-sync'],
    });

    const state: SyncState = {
      ...EMPTY,
      items: {
        [local.stableKey]: {
          stableKey: local.stableKey,
          chromeId: 'c2',
          lwLinkId: 20,
          url: local.url,
          title: 'B',
          folderPath: 'Work',
          contentHash: local.contentHash,
          lastSyncedAt: 1000,
        },
      },
    };

    const plan2 = buildPlan([local], [remote], state, 'bidirectional', 2000);
    expect(plan2.actions).toEqual([]);
    expect(local.contentHash).toBe(remote.contentHash);
  });

  it('C: local delete of a tagged item deletes remote', async () => {
    const remote = await createRemoteItem({
      lwLinkId: 30,
      url: 'https://example.com/c',
      title: 'C',
      folderPath: 'Dev',
      tags: ['browser-sync'],
    });
    const state: SyncState = {
      ...EMPTY,
      items: {
        [remote.stableKey]: {
          stableKey: remote.stableKey,
          chromeId: 'c3',
          lwLinkId: 30,
          url: remote.url,
          title: 'C',
          folderPath: 'Dev',
          contentHash: remote.contentHash,
          lastSyncedAt: 1000,
        },
      },
    };
    // gone locally, still remote (with tag) -> deleteRemote
    const plan = buildPlan([], [remote], state, 'bidirectional', 2000);
    expect(plan.actions.map((a) => a.type)).toEqual(['deleteRemote']);
  });

  it('D: local delete of a known UNTAGGED remote item deletes remote', async () => {
    const remote = await createRemoteItem({
      lwLinkId: 40,
      url: 'https://example.com/d',
      title: 'D',
      folderPath: 'Dev',
      tags: [], // KEIN browser-sync Tag
    });
    const state: SyncState = {
      ...EMPTY,
      items: {
        [remote.stableKey]: {
          stableKey: remote.stableKey,
          chromeId: 'c4',
          lwLinkId: 40,
          url: remote.url,
          title: 'D',
          folderPath: 'Dev',
          contentHash: remote.contentHash,
          lastSyncedAt: 1000,
        },
      },
    };
    const plan = buildPlan([], [remote], state, 'bidirectional', 2000);
    expect(plan.actions).toMatchObject([
      { type: 'deleteRemote', reason: 'deleted:local' },
    ]);
    expect(plan.stateDelta.remove).toContain(remote.stableKey);
  });

  it('E: remote delete removes local bookmark', async () => {
    const local = await createLocalItem({
      chromeId: 'c5',
      url: 'https://example.com/e',
      title: 'E',
      folderPath: 'Dev',
    });
    const state: SyncState = {
      ...EMPTY,
      items: {
        [local.stableKey]: {
          stableKey: local.stableKey,
          chromeId: 'c5',
          lwLinkId: 50,
          url: local.url,
          title: 'E',
          folderPath: 'Dev',
          contentHash: local.contentHash,
          lastSyncedAt: 1000,
        },
      },
    };
    // gone remotely, still local -> deleteLocal
    const plan = buildPlan([local], [], state, 'bidirectional', 2000);
    expect(plan.actions.map((a) => a.type)).toEqual(['deleteLocal']);
  });
});
