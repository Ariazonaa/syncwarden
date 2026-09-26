import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SYNC_PREFERENCES,
  commitConnectionConfiguration,
  loadLinkwardenSettings,
  saveLinkwardenSettings,
} from '../src/adapters/storage';

const TOKEN = 'lw-secret-token-123';

function installStorage(values: Record<string, unknown>): void {
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: values[key] })),
        set: vi.fn(async (next: Record<string, unknown>) => {
          Object.assign(values, next);
        }),
        remove: vi.fn(async (key: string) => delete values[key]),
      },
    },
  });
}

describe('access token at rest', () => {
  beforeEach(() => vi.stubGlobal('indexedDB', new IDBFactory()));
  afterEach(() => vi.unstubAllGlobals());

  it('stores the token encrypted and reads it back', async () => {
    const values: Record<string, unknown> = {};
    installStorage(values);

    await saveLinkwardenSettings({ baseUrl: 'https://links.test', token: TOKEN });

    expect(JSON.stringify(values)).not.toContain(TOKEN);
    expect(values.linkwardenSettings).not.toHaveProperty('token');
    await expect(loadLinkwardenSettings()).resolves.toEqual({
      baseUrl: 'https://links.test',
      token: TOKEN,
    });
  });

  it('encrypts the token when committing a connection', async () => {
    const values: Record<string, unknown> = {};
    installStorage(values);

    await commitConnectionConfiguration(
      { baseUrl: 'https://links.test', token: TOKEN },
      DEFAULT_SYNC_PREFERENCES,
      true,
    );

    expect(JSON.stringify(values)).not.toContain(TOKEN);
    await expect(loadLinkwardenSettings()).resolves.toEqual({
      baseUrl: 'https://links.test',
      token: TOKEN,
    });
  });

  it('uses a fresh IV for every save', async () => {
    const values: Record<string, unknown> = {};
    installStorage(values);

    await saveLinkwardenSettings({ baseUrl: 'https://links.test', token: TOKEN });
    const first = JSON.stringify(values.linkwardenSettings);
    await saveLinkwardenSettings({ baseUrl: 'https://links.test', token: TOKEN });

    expect(JSON.stringify(values.linkwardenSettings)).not.toBe(first);
  });

  it('migrates a plaintext token from older versions', async () => {
    const values: Record<string, unknown> = {
      linkwardenSettings: { baseUrl: 'https://links.test', token: TOKEN },
    };
    installStorage(values);

    await expect(loadLinkwardenSettings()).resolves.toEqual({
      baseUrl: 'https://links.test',
      token: TOKEN,
    });
    expect(JSON.stringify(values)).not.toContain(TOKEN);
    await expect(loadLinkwardenSettings()).resolves.toEqual({
      baseUrl: 'https://links.test',
      token: TOKEN,
    });
  });

  it('treats the connection as missing when the device key is gone', async () => {
    const values: Record<string, unknown> = {};
    installStorage(values);
    await saveLinkwardenSettings({ baseUrl: 'https://links.test', token: TOKEN });

    vi.stubGlobal('indexedDB', new IDBFactory());

    await expect(loadLinkwardenSettings()).resolves.toBeNull();
  });
});
