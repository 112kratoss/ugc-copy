import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  createMemorySessionStorage,
  createSecureSessionStorage,
  secureSessionStorage,
  splitValueIntoChunks,
} from '../lib/secure-session-storage';

const KEY = 'sb-project-auth-token';

function utf8Bytes(value: string) {
  return Buffer.byteLength(value, 'utf8');
}

function memorySecureStore() {
  const values = new Map<string, string>();
  return {
    values,
    getItemAsync: vi.fn(async (key: string) => values.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    deleteItemAsync: vi.fn(async (key: string) => {
      values.delete(key);
    }),
  };
}

function memoryAsyncStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: vi.fn(async (key: string) => values.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      values.delete(key);
    }),
  };
}

function createHarness() {
  const secureStore = memorySecureStore();
  const asyncStorage = memoryAsyncStorage();
  const warn = vi.fn();
  const invalidateSession = vi.fn();
  const storage = createSecureSessionStorage({
    secureStore,
    asyncStorage,
    warn,
    invalidateSession,
  });
  return { secureStore, asyncStorage, warn, invalidateSession, storage };
}

function fakeSessionJson(byteLength: number) {
  const payload = 'a'.repeat(Math.max(byteLength - 60, 1));
  return JSON.stringify({ access_token: payload, refresh_token: 'refresh-1', expires_at: 1753400000 });
}

describe('splitValueIntoChunks', () => {
  it('keeps every chunk within the byte budget and reassembles losslessly', () => {
    const value = fakeSessionJson(6000);
    const chunks = splitValueIntoChunks(value);

    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(utf8Bytes(chunk)).toBeLessThanOrEqual(1900);
    }
    expect(chunks.join('')).toBe(value);
  });

  it('never tears surrogate pairs at chunk boundaries', () => {
    const value = `${'x'.repeat(1899)}📚${'é'.repeat(2000)}📚`.repeat(3);
    const chunks = splitValueIntoChunks(value);

    for (const chunk of chunks) {
      expect(utf8Bytes(chunk)).toBeLessThanOrEqual(1900);
      // A chunk must never end on a lone high surrogate (torn emoji).
      const lastCode = chunk.charCodeAt(chunk.length - 1);
      expect(lastCode < 0xd800 || lastCode > 0xdbff).toBe(true);
    }
    expect(chunks.join('')).toBe(value);
  });

  it('represents the empty string as a single empty chunk', () => {
    expect(splitValueIntoChunks('')).toEqual(['']);
  });
});

describe('secure session storage', () => {
  it('round-trips a small value through SecureStore chunks', async () => {
    const { storage, secureStore, asyncStorage } = createHarness();

    await storage.setItem(KEY, 'small-session');

    expect(secureStore.values.get(`${KEY}.meta`)).toBe('1');
    expect(secureStore.values.get(`${KEY}.0`)).toBe('small-session');
    expect(asyncStorage.values.has(KEY)).toBe(false);
    await expect(storage.getItem(KEY)).resolves.toBe('small-session');
  });

  it('round-trips a session larger than 4KB across <=1900-byte chunks', async () => {
    const { storage, secureStore } = createHarness();
    const value = fakeSessionJson(8200);

    await storage.setItem(KEY, value);

    const meta = Number(secureStore.values.get(`${KEY}.meta`));
    expect(meta).toBeGreaterThanOrEqual(5);
    for (let index = 0; index < meta; index += 1) {
      const chunk = secureStore.values.get(`${KEY}.${index}`);
      expect(chunk).toBeTypeOf('string');
      expect(utf8Bytes(chunk as string)).toBeLessThanOrEqual(1900);
    }
    await expect(storage.getItem(KEY)).resolves.toBe(value);
  });

  it('round-trips multibyte content exactly', async () => {
    const { storage } = createHarness();
    const value = JSON.stringify({ user_metadata: { full_name: `név ✨${'📚'.repeat(1200)}` } });

    await storage.setItem(KEY, value);

    await expect(storage.getItem(KEY)).resolves.toBe(value);
  });

  it('round-trips the empty string', async () => {
    const { storage } = createHarness();

    await storage.setItem(KEY, '');

    await expect(storage.getItem(KEY)).resolves.toBe('');
  });

  it('migrates a legacy AsyncStorage session into SecureStore on first read', async () => {
    const { storage, secureStore, asyncStorage } = createHarness();
    const legacySession = fakeSessionJson(4300);
    asyncStorage.values.set(KEY, legacySession);

    // Existing logged-in users keep their session on the very first read.
    await expect(storage.getItem(KEY)).resolves.toBe(legacySession);

    expect(asyncStorage.values.has(KEY)).toBe(false);
    expect(secureStore.values.get(`${KEY}.meta`)).toBeDefined();

    // Subsequent reads are served from SecureStore alone.
    asyncStorage.values.clear();
    await expect(storage.getItem(KEY)).resolves.toBe(legacySession);
  });

  it('returns null when neither store has the key', async () => {
    const { storage } = createHarness();

    await expect(storage.getItem(KEY)).resolves.toBeNull();
  });

  it('wipes the legacy plaintext session and signs out when migration writes fail', async () => {
    const { storage, secureStore, asyncStorage, warn, invalidateSession } = createHarness();
    const legacySession = fakeSessionJson(4300);
    asyncStorage.values.set(KEY, legacySession);
    secureStore.setItemAsync.mockRejectedValue(new Error('keystore unavailable'));

    await expect(storage.getItem(KEY)).resolves.toBeNull();
    expect(asyncStorage.values.has(KEY)).toBe(false);
    expect(asyncStorage.setItem).not.toHaveBeenCalled();
    expect(invalidateSession).toHaveBeenCalledWith('secure-store-unavailable');
    expect(warn).toHaveBeenCalledWith(
      'SecureStore is unavailable; signing out.',
      expect.any(Error),
    );
  });

  it('removes every chunk, the meta entry, and the legacy copy on removeItem', async () => {
    const { storage, secureStore, asyncStorage } = createHarness();
    asyncStorage.values.set(KEY, 'stale-plaintext');
    await storage.setItem(KEY, fakeSessionJson(8200));

    await storage.removeItem(KEY);

    expect(secureStore.values.size).toBe(0);
    expect(asyncStorage.values.has(KEY)).toBe(false);
    await expect(storage.getItem(KEY)).resolves.toBeNull();
  });

  it('cleans up orphaned chunks beyond the recorded count on removeItem', async () => {
    const { storage, secureStore } = createHarness();
    await storage.setItem(KEY, fakeSessionJson(8200));
    // Simulate an interrupted earlier shrink: meta says 1 chunk but more exist.
    secureStore.values.set(`${KEY}.meta`, '1');

    await storage.removeItem(KEY);

    expect(secureStore.values.size).toBe(0);
  });

  it('deletes stale chunk entries when a value shrinks', async () => {
    const { storage, secureStore } = createHarness();
    const large = fakeSessionJson(8200);
    await storage.setItem(KEY, large);
    const largeChunkCount = Number(secureStore.values.get(`${KEY}.meta`));
    expect(largeChunkCount).toBeGreaterThan(1);

    await storage.setItem(KEY, 'tiny');

    expect(secureStore.values.get(`${KEY}.meta`)).toBe('1');
    for (let index = 1; index < largeChunkCount; index += 1) {
      expect(secureStore.values.has(`${KEY}.${index}`)).toBe(false);
    }
    await expect(storage.getItem(KEY)).resolves.toBe('tiny');
  });

  it('invalidates the commit marker before rewriting any live chunk', async () => {
    const { storage, secureStore } = createHarness();
    await storage.setItem(KEY, fakeSessionJson(8200));
    const operations: string[] = [];

    secureStore.setItemAsync.mockImplementation(async (key, value) => {
      operations.push(`set:${key}`);
      secureStore.values.set(key, value);
    });
    secureStore.deleteItemAsync.mockImplementation(async (key) => {
      operations.push(`delete:${key}`);
      secureStore.values.delete(key);
    });

    await storage.setItem(KEY, fakeSessionJson(4300));

    const markerDelete = operations.indexOf(`delete:${KEY}.meta`);
    const firstChunkWrite = operations.indexOf(`set:${KEY}.0`);
    const markerCommit = operations.indexOf(`set:${KEY}.meta`);
    const lastChunkWrite = Math.max(
      ...operations
        .map((operation, index) => operation.startsWith(`set:${KEY}.`) && operation !== `set:${KEY}.meta`
          ? index
          : -1),
    );
    expect(markerDelete).toBeGreaterThanOrEqual(0);
    expect(markerDelete).toBeLessThan(firstChunkWrite);
    expect(markerCommit).toBeGreaterThan(lastChunkWrite);
  });

  it('wipes plaintext and signs out instead of falling back when SecureStore reads throw', async () => {
    const { storage, secureStore, asyncStorage, warn, invalidateSession } = createHarness();
    asyncStorage.values.set(KEY, 'plaintext-session');
    secureStore.getItemAsync.mockRejectedValue(new Error('SecureStore is not available'));

    await expect(storage.getItem(KEY)).resolves.toBeNull();
    expect(asyncStorage.values.has(KEY)).toBe(false);
    expect(asyncStorage.setItem).not.toHaveBeenCalled();
    expect(invalidateSession).toHaveBeenCalledWith('secure-store-unavailable');
    expect(warn).toHaveBeenCalledWith(
      'SecureStore is unavailable; signing out.',
      expect.any(Error),
    );
  });

  it('rejects login, wipes plaintext, and signs out when SecureStore writes throw', async () => {
    const { storage, secureStore, asyncStorage, warn, invalidateSession } = createHarness();
    secureStore.setItemAsync.mockRejectedValue(new Error('keystore write failed'));
    const session = fakeSessionJson(4300);

    await expect(storage.setItem(KEY, session)).rejects.toMatchObject({
      code: 'SECURE_SESSION_STORAGE_UNAVAILABLE',
      reason: 'secure-store-unavailable',
    });
    expect(asyncStorage.values.has(KEY)).toBe(false);
    expect(asyncStorage.setItem).not.toHaveBeenCalled();
    expect(invalidateSession).toHaveBeenCalledWith('secure-store-unavailable');
    expect(warn).toHaveBeenCalledWith(
      'SecureStore is unavailable; signing out.',
      expect.any(Error),
    );
  });

  it('erases corrupted metadata and plaintext before signing out', async () => {
    const { storage, secureStore, asyncStorage, invalidateSession } = createHarness();
    secureStore.values.set(`${KEY}.meta`, 'not-a-number');
    secureStore.values.set(`${KEY}.0`, 'chunk');
    asyncStorage.values.set(KEY, 'stale-plaintext');

    await expect(storage.getItem(KEY)).resolves.toBeNull();
    expect(secureStore.values.size).toBe(0);
    expect(asyncStorage.values.has(KEY)).toBe(false);
    expect(invalidateSession).toHaveBeenCalledWith('corrupt-secure-value');
  });

  it('signs out after an interrupted rewrite instead of joining new and old chunks', async () => {
    const { storage, secureStore, asyncStorage, invalidateSession } = createHarness();
    await storage.setItem(KEY, fakeSessionJson(8200));
    // The writer removes the old commit marker before touching chunks. Model a
    // process death after it overwrote only chunk zero, leaving the old tail.
    secureStore.values.delete(`${KEY}.meta`);
    secureStore.values.set(`${KEY}.0`, 'partial-new-session');
    asyncStorage.values.set(KEY, 'stale-plaintext');

    await expect(storage.getItem(KEY)).resolves.toBeNull();
    expect(secureStore.values.size).toBe(0);
    expect(asyncStorage.values.has(KEY)).toBe(false);
    expect(invalidateSession).toHaveBeenCalledWith('corrupt-secure-value');
  });

  it('erases incomplete chunks and signs out instead of returning a truncated session', async () => {
    const { storage, secureStore, asyncStorage, invalidateSession } = createHarness();
    await storage.setItem(KEY, fakeSessionJson(8200));
    secureStore.values.delete(`${KEY}.2`);
    asyncStorage.values.set(KEY, 'stale-plaintext');

    await expect(storage.getItem(KEY)).resolves.toBeNull();
    expect(secureStore.values.size).toBe(0);
    expect(asyncStorage.values.has(KEY)).toBe(false);
    expect(invalidateSession).toHaveBeenCalledWith('corrupt-secure-value');
  });

  it('rejects oversized sessions without ever persisting them to AsyncStorage', async () => {
    const { storage, secureStore, asyncStorage, invalidateSession } = createHarness();
    const oversizedSession = fakeSessionJson((1900 * 256) + 1);

    await expect(storage.setItem(KEY, oversizedSession)).rejects.toMatchObject({
      code: 'SECURE_SESSION_STORAGE_UNAVAILABLE',
      reason: 'secure-value-too-large',
    });

    expect(secureStore.values.size).toBe(0);
    expect(asyncStorage.values.has(KEY)).toBe(false);
    expect(asyncStorage.setItem).not.toHaveBeenCalled();
    expect(invalidateSession).toHaveBeenCalledWith('secure-value-too-large');
  });

  it('serializes concurrent writes so the last value wins intact', async () => {
    const { storage, secureStore } = createHarness();
    const first = fakeSessionJson(8200);
    const second = fakeSessionJson(2500);

    await Promise.all([
      storage.setItem(KEY, first),
      storage.setItem(KEY, second),
    ]);

    await expect(storage.getItem(KEY)).resolves.toBe(second);
    const meta = Number(secureStore.values.get(`${KEY}.meta`));
    expect(Number.isInteger(meta)).toBe(true);
    // No stale chunks beyond the final chunk count.
    const chunkKeys = [...secureStore.values.keys()].filter((key) => key !== `${KEY}.meta`);
    expect(chunkKeys.length).toBe(meta);
  });

  it('wires the default adapter to expo-secure-store and AsyncStorage', async () => {
    const secureValues = new Map<string, string>();
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => secureValues.get(key) ?? null);
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      secureValues.set(key, value);
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      secureValues.delete(key);
    });

    await secureSessionStorage.setItem(KEY, 'default-wiring');

    expect(secureValues.get(`${KEY}.meta`)).toBe('1');
    expect(secureValues.get(`${KEY}.0`)).toBe('default-wiring');
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith(KEY);
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
    await expect(secureSessionStorage.getItem(KEY)).resolves.toBe('default-wiring');
    await secureSessionStorage.removeItem(KEY);
    expect(secureValues.size).toBe(0);
  });
});

describe('memory-only web session storage', () => {
  it('round-trips only inside the current adapter instance', async () => {
    const firstRuntime = createMemorySessionStorage();
    const nextRuntime = createMemorySessionStorage();

    await firstRuntime.setItem(KEY, 'web-session');

    await expect(firstRuntime.getItem(KEY)).resolves.toBe('web-session');
    await expect(nextRuntime.getItem(KEY)).resolves.toBeNull();
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });
});
