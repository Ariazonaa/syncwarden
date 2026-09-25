import { describe, expect, it } from 'vitest';
import {
  createLocalItem,
  createRemoteItem,
} from '../src/core/keys';
import { buildPlan } from '../src/core/sync-engine';
import {
  createEmptySyncState,
  recoverSyncState,
  type LocalItem,
  type RemoteItem,
  type SyncMode,
  type SyncState,
  type SyncedItem,
} from '../src/core/types';

const NOW = 1_700_000_000_000;

async function local(
  suffix: string,
  overrides: Partial<{
    chromeId: string;
    title: string;
    folderPath: string;
  }> = {},
): Promise<LocalItem> {
  return createLocalItem({
    chromeId: overrides.chromeId ?? `chrome-${suffix}`,
    url: `https://example.com/${suffix}`,
    title: overrides.title ?? `Title ${suffix}`,
    folderPath: overrides.folderPath ?? 'Bookmarks Bar/Dev',
  });
}

async function remote(
  suffix: string,
  overrides: Partial<{
    lwLinkId: number;
    title: string;
    folderPath: string;
    tags: string[];
  }> = {},
): Promise<RemoteItem> {
  return createRemoteItem({
    lwLinkId: overrides.lwLinkId ?? numericId(suffix),
    url: `https://example.com/${suffix}`,
    title: overrides.title ?? `Title ${suffix}`,
    folderPath: overrides.folderPath ?? 'Bookmarks Bar/Dev',
    tags: overrides.tags ?? ['browser-sync'],
  });
}

function numericId(value: string): number {
  let result = 0;
  for (const character of value) {
    result = (result * 31 + character.charCodeAt(0)) % 100_000;
  }
  return result;
}

function synced(
  localItem: LocalItem | null,
  remoteItem: RemoteItem | null,
  content?: Pick<LocalItem, 'url' | 'title' | 'folderPath' | 'contentHash'>,
): SyncedItem {
  const winner = content ?? localItem ?? remoteItem;
  if (winner === null) {
    throw new Error('Synced item requires content.');
  }
  return {
    stableKey: (localItem ?? remoteItem)?.stableKey ?? '',
    chromeId: localItem?.chromeId ?? null,
    lwLinkId: remoteItem?.lwLinkId ?? null,
    url: winner.url,
    title: winner.title,
    folderPath: winner.folderPath,
    contentHash: winner.contentHash,
    lastSyncedAt: NOW - 1000,
  };
}

function stateWith(...items: SyncedItem[]): SyncState {
  return {
    ...createEmptySyncState(),
    items: Object.fromEntries(items.map((item) => [item.stableKey, item])),
  };
}

function plan(
  localItems: LocalItem[],
  remoteItems: RemoteItem[],
  state: SyncState,
  mode: SyncMode = 'bidirectional',
) {
  return buildPlan(localItems, remoteItems, state, mode, NOW);
}

describe('new inventory', () => {
  it('creates a remote link for a new local bookmark', async () => {
    const item = await local('new-local');
    const result = plan([item], [], createEmptySyncState(), 'additive-up');
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      type: 'createRemote',
      stableKey: item.stableKey,
      reason: 'new:local',
    });
  });

  it('ignores a new remote link in additive-up', async () => {
    const item = await remote('new-remote');
    const result = plan([], [item], createEmptySyncState(), 'additive-up');
    expect(result.actions).toEqual([]);
    expect(result.stateDelta.upsert).toEqual({});
  });

  it.each<SyncMode>(['additive-both', 'bidirectional'])(
    'creates a local bookmark for a new remote link in %s',
    async (mode) => {
      const item = await remote(`new-${mode}`);
      expect(
        plan([], [item], createEmptySyncState(), mode).actions,
      ).toMatchObject([{ type: 'createLocal', reason: 'new:remote' }]);
    },
  );

  it('merges identical pre-existing inventories through state only', async () => {
    const localItem = await local('merge');
    const remoteItem = await remote('merge');
    const result = plan(
      [localItem],
      [remoteItem],
      createEmptySyncState(),
      'additive-both',
    );
    expect(result.actions).toEqual([]);
    expect(result.stateDelta.upsert[localItem.stableKey]?.commit).toBe(
      'immediate',
    );
  });

  it('adopts an identical remote link that lacks the browser-sync tag', async () => {
    const localItem = await local('adopt');
    const remoteItem = await remote('adopt', { tags: [] });
    const result = plan(
      [localItem],
      [remoteItem],
      createEmptySyncState(),
      'bidirectional',
    );
    // Same content but the tag is missing -> exactly one adopt action.
    expect(result.actions.map((action) => action.type)).toEqual([
      'adoptRemote',
    ]);
    expect(result.actions[0]?.reason).toBe('adopt:missing-tag');
    // Adoption is not a deletion.
    expect(result.deletionCount).toBe(0);
    expect(result.blocked).toBe(false);
    // The state upsert is only committed after the action succeeded.
    expect(result.stateDelta.upsert[localItem.stableKey]?.commit).toBe(
      'after-action',
    );
  });

  it('does not adopt when the remote link already carries the tag', async () => {
    const localItem = await local('already-tagged');
    const remoteItem = await remote('already-tagged', {
      tags: ['browser-sync'],
    });
    const result = plan(
      [localItem],
      [remoteItem],
      createEmptySyncState(),
      'bidirectional',
    );
    expect(result.actions).toEqual([]);
    expect(result.stateDelta.upsert[localItem.stableKey]?.commit).toBe(
      'immediate',
    );
  });

  it('blocks an initial same-URL metadata conflict', async () => {
    const localItem = await local('initial-conflict', { title: 'Local' });
    const remoteItem = await remote('initial-conflict', { title: 'Remote' });
    const result = plan(
      [localItem],
      [remoteItem],
      createEmptySyncState(),
      'additive-both',
    );
    expect(result.blocked).toBe(true);
    expect(result.blockReason).toContain('First sync held back');
    expect(result.actions).toMatchObject([
      { type: 'updateRemote', reason: 'conflict:initial-local-wins' },
    ]);
    expect(result.stateDelta.upsert[localItem.stableKey]?.commit).toBe(
      'after-action',
    );
  });

  it('keeps an empty state purely additive even in bidirectional mode', async () => {
    const localOnly = await local('empty-local');
    const remoteOnly = await remote('empty-remote');
    const result = plan(
      [localOnly],
      [remoteOnly],
      createEmptySyncState(),
      'bidirectional',
    );
    expect(result.actions.map((action) => action.type).sort()).toEqual([
      'createLocal',
      'createRemote',
    ]);
    expect(result.deletionCount).toBe(0);
  });

  it('recovers a corrupt state as purely additive', async () => {
    const recovery = recoverSyncState({ schemaVersion: 1, items: 'broken' });
    const localItem = await local('corrupt-local');
    const remoteItem = await remote('corrupt-remote');
    const result = plan(
      [localItem],
      [remoteItem],
      recovery.state,
      'bidirectional',
    );
    expect(recovery.recoveredFromCorruption).toBe(true);
    expect(result.deletionCount).toBe(0);
    expect(result.actions.every((action) => action.type.startsWith('create'))).toBe(
      true,
    );
  });
});

describe('known inventory and changes', () => {
  it('does nothing when all three hashes match', async () => {
    const localItem = await local('same');
    const remoteItem = await remote('same');
    const result = plan(
      [localItem],
      [remoteItem],
      stateWith(synced(localItem, remoteItem)),
    );
    expect(result.actions).toEqual([]);
  });

  it('does not delete when every Chrome ID changes', async () => {
    const originals = await Promise.all(
      Array.from({ length: 12 }, (_, index) => local(`ids-${index}`)),
    );
    const remotes = await Promise.all(
      Array.from({ length: 12 }, (_, index) => remote(`ids-${index}`)),
    );
    const changedIds = originals.map((item, index) => ({
      ...item,
      chromeId: `entirely-new-id-${index}`,
    }));
    const state = stateWith(
      ...originals.map((item, index) => synced(item, remotes[index] ?? null)),
    );
    const result = plan(changedIds, remotes, state);
    expect(result.actions).toEqual([]);
    expect(result.deletionCount).toBe(0);
  });

  it('updates remote exactly once after a local rename', async () => {
    const before = await local('local-rename', { title: 'Before' });
    const remoteItem = await remote('local-rename', { title: 'Before' });
    const after = await local('local-rename', { title: 'After' });
    const result = plan(
      [after],
      [remoteItem],
      stateWith(synced(before, remoteItem)),
    );
    expect(result.actions).toMatchObject([
      { type: 'updateRemote', reason: 'changed:local' },
    ]);
  });

  it('updates local after a remote rename in additive-both', async () => {
    const localItem = await local('remote-rename', { title: 'Before' });
    const before = await remote('remote-rename', { title: 'Before' });
    const after = await remote('remote-rename', { title: 'After' });
    const result = plan(
      [localItem],
      [after],
      stateWith(synced(localItem, before)),
      'additive-both',
    );
    expect(result.actions).toMatchObject([
      { type: 'updateLocal', reason: 'changed:remote' },
    ]);
  });

  it('uses local wins for a later two-sided conflict', async () => {
    const beforeLocal = await local('later-conflict', { title: 'Before' });
    const beforeRemote = await remote('later-conflict', { title: 'Before' });
    const localAfter = await local('later-conflict', { title: 'Local' });
    const remoteAfter = await remote('later-conflict', { title: 'Remote' });
    const result = plan(
      [localAfter],
      [remoteAfter],
      stateWith(synced(beforeLocal, beforeRemote)),
    );
    expect(result.actions).toMatchObject([
      { type: 'updateRemote', reason: 'conflict:local-wins' },
    ]);
  });

  it('accepts matching convergence without an action', async () => {
    const beforeLocal = await local('converged', { title: 'Before' });
    const beforeRemote = await remote('converged', { title: 'Before' });
    const localAfter = await local('converged', { title: 'Same new value' });
    const remoteAfter = await remote('converged', { title: 'Same new value' });
    const result = plan(
      [localAfter],
      [remoteAfter],
      stateWith(synced(beforeLocal, beforeRemote)),
    );
    expect(result.actions).toEqual([]);
    expect(result.stateDelta.upsert[localAfter.stableKey]?.item.contentHash).toBe(
      localAfter.contentHash,
    );
  });

  it('keeps local authoritative when only remote drifts in additive-up', async () => {
    const localItem = await local('up-source', { title: 'Local source' });
    const remoteBefore = await remote('up-source', { title: 'Local source' });
    const remoteAfter = await remote('up-source', { title: 'Remote drift' });
    const result = plan(
      [localItem],
      [remoteAfter],
      stateWith(synced(localItem, remoteBefore)),
      'additive-up',
    );
    expect(result.actions).toMatchObject([
      { type: 'updateRemote', reason: 'source:local' },
    ]);
  });

  it('injects now into state upserts', async () => {
    const localItem = await local('now');
    const result = plan([localItem], [], createEmptySyncState(), 'additive-up');
    expect(result.stateDelta.upsert[localItem.stableKey]?.item.lastSyncedAt).toBe(
      NOW,
    );
  });
});

describe('missing known items by mode', () => {
  it('does not delete remote after a local deletion in additive-up', async () => {
    const localBefore = await local('deleted-local-up');
    const remoteItem = await remote('deleted-local-up');
    const result = plan(
      [],
      [remoteItem],
      stateWith(synced(localBefore, remoteItem)),
      'additive-up',
    );
    expect(result.actions).toEqual([]);
    expect(result.deletionCount).toBe(0);
  });

  it('recreates a missing remote item in additive-up', async () => {
    const localItem = await local('deleted-remote-up');
    const remoteBefore = await remote('deleted-remote-up');
    const result = plan(
      [localItem],
      [],
      stateWith(synced(localItem, remoteBefore)),
      'additive-up',
    );
    expect(result.actions).toMatchObject([
      { type: 'createRemote', reason: 'missing:remote-recreate' },
    ]);
  });

  it('recreates a missing local item in additive-both', async () => {
    const localBefore = await local('deleted-local-both');
    const remoteItem = await remote('deleted-local-both');
    const result = plan(
      [],
      [remoteItem],
      stateWith(synced(localBefore, remoteItem)),
      'additive-both',
    );
    expect(result.actions).toMatchObject([
      { type: 'createLocal', reason: 'missing:local-recreate' },
    ]);
  });

  it('recreates a missing remote item in additive-both', async () => {
    const localItem = await local('deleted-remote-both');
    const remoteBefore = await remote('deleted-remote-both');
    const result = plan(
      [localItem],
      [],
      stateWith(synced(localItem, remoteBefore)),
      'additive-both',
    );
    expect(result.actions).toMatchObject([
      { type: 'createRemote', reason: 'missing:remote-recreate' },
    ]);
  });

  it('deletes a tagged remote item after a local deletion in bidirectional', async () => {
    const localBefore = await local('delete-remote');
    const remoteItem = await remote('delete-remote');
    const result = plan(
      [],
      [remoteItem],
      stateWith(synced(localBefore, remoteItem)),
    );
    expect(result.actions).toMatchObject([
      { type: 'deleteRemote', reason: 'deleted:local' },
    ]);
    expect(result.stateDelta.remove).toContain(remoteItem.stableKey);
  });

  it('deletes a known remote item even when its sync tag is missing', async () => {
    const localBefore = await local('untagged-delete');
    const remoteItem = await remote('untagged-delete', { tags: [] });
    const result = plan(
      [],
      [remoteItem],
      stateWith(synced(localBefore, remoteItem)),
    );
    expect(result.actions).toMatchObject([
      { type: 'deleteRemote', reason: 'deleted:local' },
    ]);
    expect(result.stateDelta.remove).toContain(remoteItem.stableKey);
    expect(result.deletionCount).toBe(1);
  });

  it('deletes local after a remote deletion in bidirectional', async () => {
    const localItem = await local('delete-local');
    const remoteBefore = await remote('delete-local');
    const result = plan(
      [localItem],
      [],
      stateWith(synced(localItem, remoteBefore)),
    );
    expect(result.actions).toMatchObject([
      { type: 'deleteLocal', reason: 'deleted:remote' },
    ]);
  });

  it('removes state when an item is absent on both sides', async () => {
    const localBefore = await local('gone');
    const remoteBefore = await remote('gone');
    const result = plan([], [], stateWith(synced(localBefore, remoteBefore)));
    expect(result.actions).toEqual([]);
    expect(result.stateDelta.remove).toEqual([localBefore.stableKey]);
  });
});

describe('deletion brake', () => {
  async function deletionInventory(total: number, deleted: number) {
    const locals = await Promise.all(
      Array.from({ length: total }, (_, index) => local(`brake-${index}`)),
    );
    const remotes = await Promise.all(
      Array.from({ length: total }, (_, index) => remote(`brake-${index}`)),
    );
    return {
      local: locals.slice(deleted),
      remote: remotes,
      state: stateWith(
        ...locals.map((item, index) => synced(item, remotes[index] ?? null)),
      ),
    };
  }

  it('blocks 20 deletions among 30 known items', async () => {
    const inventory = await deletionInventory(30, 20);
    const result = plan(inventory.local, inventory.remote, inventory.state);
    expect(result.deletionCount).toBe(20);
    expect(result.blocked).toBe(true);
    expect(result.blockReason).toContain('Deletion guard');
  });

  it('allows exactly five deletions among 30 known items', async () => {
    const inventory = await deletionInventory(30, 5);
    const result = plan(inventory.local, inventory.remote, inventory.state);
    expect(result.deletionCount).toBe(5);
    expect(result.blocked).toBe(false);
  });

  it('blocks six deletions among 30 known items', async () => {
    const inventory = await deletionInventory(30, 6);
    expect(
      plan(inventory.local, inventory.remote, inventory.state).blocked,
    ).toBe(true);
  });

  it('allows ten deletions among 100 known items', async () => {
    const inventory = await deletionInventory(100, 10);
    const result = plan(inventory.local, inventory.remote, inventory.state);
    expect(result.deletionCount).toBe(10);
    expect(result.blocked).toBe(false);
  });
});

describe('duplicates and repeatability', () => {
  it('reports duplicate local URLs without deleting either', async () => {
    const first = await local('duplicate', { title: 'A', folderPath: 'Z' });
    const second = await local('duplicate', { title: 'B', folderPath: 'A' });
    const result = plan(
      [first, second],
      [],
      createEmptySyncState(),
      'additive-up',
    );
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.type).toBe('createRemote');
    expect(result.notices).toMatchObject([{ type: 'duplicate-local' }]);
    expect(result.deletionCount).toBe(0);
  });

  it('prefers the duplicate matching the prior content hash', async () => {
    const prior = await local('duplicate-prior', {
      title: 'Prior',
      folderPath: 'Z',
    });
    const other = await local('duplicate-prior', {
      title: 'Other',
      folderPath: 'A',
    });
    const remoteItem = await remote('duplicate-prior', {
      title: 'Prior',
      folderPath: 'Z',
    });
    const result = plan(
      [other, prior],
      [remoteItem],
      stateWith(synced(prior, remoteItem)),
    );
    expect(result.actions).toEqual([]);
    expect(result.notices).toMatchObject([{ type: 'duplicate-local' }]);
  });

  it('reports duplicate remote URLs deterministically', async () => {
    const first = await remote('duplicate-remote', { title: 'Z' });
    const second = await remote('duplicate-remote', { title: 'A' });
    const result = plan(
      [],
      [first, second],
      createEmptySyncState(),
      'additive-both',
    );
    expect(result.actions).toHaveLength(1);
    expect(result.notices).toMatchObject([{ type: 'duplicate-remote' }]);
  });

  it('does not infer a remote deletion while a local URL is duplicated', async () => {
    const prior = await local('duplicate-delete-local', { title: 'Prior' });
    const duplicate = await local('duplicate-delete-local', {
      title: 'Duplicate',
    });
    const previousRemote = await remote('duplicate-delete-local', {
      title: 'Prior',
    });
    const result = plan(
      [prior, duplicate],
      [],
      stateWith(synced(prior, previousRemote)),
      'bidirectional',
    );

    expect(result.actions).toEqual([]);
    expect(result.notices).toMatchObject([{ type: 'duplicate-local' }]);
  });

  it('does not infer a local deletion while a remote URL is duplicated', async () => {
    const previousLocal = await local('duplicate-delete-remote', {
      title: 'Prior',
    });
    const prior = await remote('duplicate-delete-remote', { title: 'Prior' });
    const duplicate = await remote('duplicate-delete-remote', {
      title: 'Duplicate',
    });
    const result = plan(
      [],
      [prior, duplicate],
      stateWith(synced(previousLocal, prior)),
      'bidirectional',
    );

    expect(result.actions).toEqual([]);
    expect(result.notices).toMatchObject([{ type: 'duplicate-remote' }]);
  });

  it('is empty for 49 rounds after the initial action is applied', async () => {
    const localItem = await local('fifty-rounds');
    const first = plan([localItem], [], createEmptySyncState(), 'additive-up');
    expect(first.actions).toHaveLength(1);

    const remoteItem = await remote('fifty-rounds', {
      title: localItem.title,
      folderPath: localItem.folderPath,
    });
    const nextState = stateWith(synced(localItem, remoteItem));
    for (let round = 2; round <= 50; round += 1) {
      const result = buildPlan(
        [localItem],
        [remoteItem],
        nextState,
        'additive-up',
        NOW + round,
      );
      expect(result.actions, `round ${round}`).toEqual([]);
    }
  });

  it('sorts actions by stable key rather than input order', async () => {
    const items = await Promise.all([local('sort-c'), local('sort-a'), local('sort-b')]);
    const result = plan(
      items,
      [],
      createEmptySyncState(),
      'additive-up',
    );
    expect(result.actions.map((action) => action.stableKey)).toEqual(
      [...result.actions.map((action) => action.stableKey)].sort(),
    );
  });
});
