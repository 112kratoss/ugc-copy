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
  const storage = createSecureSessionStorage({ secureStore, asyncStorage, warn });
  return { secureStore, asyncStorage, warn, storage };
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

  it('keeps the legacy AsyncStorage copy when migration writes fail', async () => {
    const { storage, secureStore, asyncStorage, warn } = createHarness();
    const legacySession = fakeSessionJson(4300);
    asyncStorage.values.set(KEY, legacySession);
    secureStore.setItemAsync.mockRejectedValue(new Error('keystore unavailable'));

    // The user still gets their session and is NOT signed out.
    await expect(storage.getItem(KEY)).resolves.toBe(legacySession);
    expect(asyncStorage.values.get(KEY)).toBe(legacySession);
    expect(warn).toHaveBeenCalledTimes(1);

    // Next launch path (fallback active): still readable.
    await expect(storage.getItem(KEY)).resolves.toBe(legacySession);
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

  it('falls back to AsyncStorage with a warning when SecureStore reads throw', async () => {
    const { storage, secureStore, asyncStorage, warn } = createHarness();
    asyncStorage.values.set(KEY, 'plaintext-session');
    secureStore.getItemAsync.mockRejectedValue(new Error('SecureStore is not available'));

    await expect(storage.getItem(KEY)).resolves.toBe('plaintext-session');
    expect(warn).toHaveBeenCalledTimes(1);

    // The fallback is sticky: later writes skip SecureStore entirely.
    secureStore.setItemAsync.mockClear();
    await storage.setItem(KEY, 'updated-session');
    expect(secureStore.setItemAsync).not.toHaveBeenCalled();
    expect(asyncStorage.values.get(KEY)).toBe('updated-session');
    await expect(storage.getItem(KEY)).resolves.toBe('updated-session');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('keeps login working when SecureStore writes throw', async () => {
    const { storage, secureStore, asyncStorage, warn } = createHarness();
    secureStore.setItemAsync.mockRejectedValue(new Error('keystore write failed'));
    const session = fakeSessionJson(4300);

    await expect(storage.setItem(KEY, session)).resolves.toBeUndefined();

    expect(asyncStorage.values.get(KEY)).toBe(session);
    expect(warn).toHaveBeenCalledTimes(1);
    await expect(storage.getItem(KEY)).resolves.toBe(session);

    // Sign-out still clears the fallback copy.
    await storage.removeItem(KEY);
    await expect(storage.getItem(KEY)).resolves.toBeNull();
  });

  it('treats corrupted metadata as a miss instead of returning garbage', async () => {
    const { storage, secureStore } = createHarness();
    secureStore.values.set(`${KEY}.meta`, 'not-a-number');
    secureStore.values.set(`${KEY}.0`, 'chunk');

    await expect(storage.getItem(KEY)).resolves.toBeNull();
  });

  it('treats a missing chunk as a miss instead of returning a truncated session', async () => {
    const { storage, secureStore } = createHarness();
    await storage.setItem(KEY, fakeSessionJson(8200));
    secureStore.values.delete(`${KEY}.2`);

    await expect(storage.getItem(KEY)).resolves.toBeNull();
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
    await expect(secureSessionStorage.getItem(KEY)).resolves.toBe('default-wiring');
    await secureSessionStorage.removeItem(KEY);
    expect(secureValues.size).toBe(0);
  });
});
