// Encrypts the Linkwarden access token at rest with a device key.
//
// The key is an AES-GCM CryptoKey created with extractable: false and kept in
// the extension's IndexedDB, which the popup and the service worker share.
// Script code can use it but never read its bytes, so the token no longer sits
// in chrome.storage as plaintext. This does not protect against someone who
// copies the whole browser profile: the key lives in that profile too.

const DB_NAME = 'syncwarden-keys';
const STORE_NAME = 'keys';
const TOKEN_KEY_ID = 'access-token';

export interface EncryptedToken {
  v: 1;
  iv: string;
  data: string;
}

export async function encryptToken(token: string): Promise<EncryptedToken> {
  const key = await getOrCreateKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(token),
  );
  return { v: 1, iv: toBase64(iv), data: toBase64(new Uint8Array(data)) };
}

/** Returns null when the key is gone or the data does not decrypt with it. */
export async function decryptToken(value: EncryptedToken): Promise<string | null> {
  const key = await readKey();
  if (key === null) {
    return null;
  }
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(value.iv) },
      key,
      fromBase64(value.data),
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

export function isEncryptedToken(value: unknown): value is EncryptedToken {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.v === 1 &&
    typeof candidate.iv === 'string' &&
    typeof candidate.data === 'string'
  );
}

async function getOrCreateKey(): Promise<CryptoKey> {
  const existing = await readKey();
  if (existing !== null) {
    return existing;
  }
  const created = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  // add() instead of put(): if the popup and the service worker race here,
  // the first key wins and the loser reads it back instead of replacing it.
  const added = await withStore('readwrite', (store) =>
    store.add(created, TOKEN_KEY_ID),
  ).then(
    () => true,
    () => false,
  );
  if (added) {
    return created;
  }
  const winner = await readKey();
  if (winner === null) {
    throw new Error('Could not store the device key.');
  }
  return winner;
}

async function readKey(): Promise<CryptoKey | null> {
  const value = await withStore('readonly', (store) => store.get(TOKEN_KEY_ID));
  return value instanceof CryptoKey ? value : null;
}

function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDatabase().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, mode);
        const request = run(transaction.objectStore(STORE_NAME));
        transaction.oncomplete = () => {
          db.close();
          resolve(request.result);
        };
        transaction.onerror = () => {
          db.close();
          reject(transaction.error ?? request.error);
        };
        transaction.onabort = () => {
          db.close();
          reject(transaction.error ?? request.error);
        };
      }),
  );
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
