import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

// Supabase auth sessions previously persisted to plaintext AsyncStorage. This
// adapter keeps the refresh token in the device keychain/keystore instead,
// while transparently migrating existing sessions so signed-in users stay
// signed in, and falling back to AsyncStorage on devices where SecureStore is
// broken so login never hard-breaks.
//
// SecureStore soft-limits values to 2048 bytes and Supabase session JSON can
// exceed that, so values are split into <= CHUNK_MAX_BYTES UTF-8 chunks stored
// as `${key}.${index}` alongside a `${key}.meta` entry holding the chunk count.

const CHUNK_MAX_BYTES = 1900;
const MAX_CHUNKS = 256;

export type SecureSessionStorage = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
};

export type SecureSessionStorageDependencies = {
  secureStore: {
    getItemAsync: (key: string) => Promise<string | null>;
    setItemAsync: (key: string, value: string) => Promise<void>;
    deleteItemAsync: (key: string) => Promise<void>;
  };
  asyncStorage: {
    getItem: (key: string) => Promise<string | null>;
    setItem: (key: string, value: string) => Promise<void>;
    removeItem: (key: string) => Promise<void>;
  };
  warn: (message: string, error?: unknown) => void;
};

const defaultDependencies: SecureSessionStorageDependencies = {
  secureStore: {
    getItemAsync: (key) => SecureStore.getItemAsync(key),
    setItemAsync: (key, value) => SecureStore.setItemAsync(key, value),
    deleteItemAsync: (key) => SecureStore.deleteItemAsync(key),
  },
  asyncStorage: {
    getItem: (key) => AsyncStorage.getItem(key),
    setItem: (key, value) => AsyncStorage.setItem(key, value),
    removeItem: (key) => AsyncStorage.removeItem(key),
  },
  warn: (message, error) => {
    console.warn(message, error);
  },
};

function chunkKey(key: string, index: number) {
  return `${key}.${index}`;
}

function metaKey(key: string) {
  return `${key}.meta`;
}

function utf8ByteSize(codePoint: number) {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/**
 * Splits a string into pieces whose UTF-8 encodings are each at most maxBytes.
 * Splits only on code-point boundaries so surrogate pairs are never torn and
 * plain concatenation of the chunks reproduces the original string.
 */
export function splitValueIntoChunks(value: string, maxBytes = CHUNK_MAX_BYTES): string[] {
  if (value.length === 0) {
    return [''];
  }

  const chunks: string[] = [];
  let chunkStart = 0;
  let chunkBytes = 0;
  let index = 0;

  while (index < value.length) {
    const codePoint = value.codePointAt(index) as number;
    const codeUnits = codePoint > 0xffff ? 2 : 1;
    const byteSize = utf8ByteSize(codePoint);
    if (chunkBytes > 0 && chunkBytes + byteSize > maxBytes) {
      chunks.push(value.slice(chunkStart, index));
      chunkStart = index;
      chunkBytes = 0;
    }
    chunkBytes += byteSize;
    index += codeUnits;
  }

  chunks.push(value.slice(chunkStart));
  return chunks;
}

function parseChunkCount(rawMeta: string | null): number | null {
  if (rawMeta === null) return null;
  const count = Number.parseInt(rawMeta, 10);
  if (!Number.isInteger(count) || String(count) !== rawMeta.trim() || count < 1 || count > MAX_CHUNKS) {
    return null;
  }
  return count;
}

export function createSecureSessionStorage(
  overrides: Partial<SecureSessionStorageDependencies> = {}
): SecureSessionStorage {
  const { secureStore, asyncStorage, warn } = { ...defaultDependencies, ...overrides };

  // Once SecureStore throws (some Android keystores are broken, and web has no
  // SecureStore at all) we stop touching it for the rest of the app session so
  // reads and writes stay consistent against a single backing store.
  let secureStoreUnavailable = false;
  const keyQueues = new Map<string, Promise<unknown>>();

  function markSecureStoreUnavailable(operation: string, error: unknown) {
    if (secureStoreUnavailable) return;
    secureStoreUnavailable = true;
    warn(
      `SecureStore ${operation} failed; falling back to AsyncStorage for auth session storage.`,
      error
    );
  }

  /** Serializes operations per key so chunked writes never interleave. */
  function withKeyQueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = keyQueues.get(key) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    keyQueues.set(key, next.then(() => undefined, () => undefined));
    return next;
  }

  async function readChunkCount(key: string) {
    return parseChunkCount(await secureStore.getItemAsync(metaKey(key)));
  }

  async function readSecureValue(key: string): Promise<string | null> {
    const chunkCount = await readChunkCount(key);
    if (chunkCount === null) return null;
    const chunks = await Promise.all(
      Array.from({ length: chunkCount }, (_, index) => secureStore.getItemAsync(chunkKey(key, index)))
    );
    if (chunks.some((chunk) => chunk === null)) return null;
    return chunks.join('');
  }

  /** Returns false when the value cannot be represented (too many chunks). */
  async function writeSecureValue(key: string, value: string): Promise<boolean> {
    const chunks = splitValueIntoChunks(value);
    if (chunks.length > MAX_CHUNKS) return false;
    const previousCount = await readChunkCount(key);
    for (let index = 0; index < chunks.length; index += 1) {
      await secureStore.setItemAsync(chunkKey(key, index), chunks[index]);
    }
    await secureStore.setItemAsync(metaKey(key), String(chunks.length));
    if (previousCount !== null) {
      for (let index = chunks.length; index < previousCount; index += 1) {
        await secureStore.deleteItemAsync(chunkKey(key, index));
      }
    }
    return true;
  }

  async function removeSecureValue(key: string) {
    const knownCount = (await readChunkCount(key)) ?? 0;
    await secureStore.deleteItemAsync(metaKey(key));
    // Delete every chunk the meta entry claims, then keep scanning so orphaned
    // chunks from an interrupted larger write are cleaned up as well.
    let index = 0;
    while (index < MAX_CHUNKS) {
      if (index >= knownCount) {
        const orphan = await secureStore.getItemAsync(chunkKey(key, index));
        if (orphan === null) break;
      }
      await secureStore.deleteItemAsync(chunkKey(key, index));
      index += 1;
    }
  }

  async function migrateLegacyValue(key: string): Promise<string | null> {
    const legacyValue = await asyncStorage.getItem(key);
    if (legacyValue === null) return null;
    try {
      const stored = await writeSecureValue(key, legacyValue);
      if (stored && (await readSecureValue(key)) === legacyValue) {
        // Only drop the plaintext copy after verifying the secure copy reads
        // back intact — an interrupted migration must never sign the user out.
        await asyncStorage.removeItem(key).catch(() => undefined);
      } else if (stored) {
        await removeSecureValue(key);
      }
    } catch (error) {
      markSecureStoreUnavailable('migration', error);
    }
    return legacyValue;
  }

  async function getItem(key: string): Promise<string | null> {
    return withKeyQueue(key, async () => {
      if (secureStoreUnavailable) {
        return asyncStorage.getItem(key);
      }
      try {
        const secureValue = await readSecureValue(key);
        if (secureValue !== null) return secureValue;
      } catch (error) {
        markSecureStoreUnavailable('read', error);
        return asyncStorage.getItem(key);
      }
      return migrateLegacyValue(key);
    });
  }

  async function setItem(key: string, value: string): Promise<void> {
    return withKeyQueue(key, async () => {
      if (secureStoreUnavailable) {
        await asyncStorage.setItem(key, value);
        return;
      }
      let stored = false;
      try {
        stored = await writeSecureValue(key, value);
      } catch (error) {
        markSecureStoreUnavailable('write', error);
      }
      if (stored) {
        // Self-heal any lingering plaintext copy from the pre-SecureStore era.
        await asyncStorage.removeItem(key).catch(() => undefined);
        return;
      }
      if (!secureStoreUnavailable) {
        warn(`Auth session value for "${key}" exceeds secure storage capacity; storing in AsyncStorage.`);
        await removeSecureValue(key).catch(() => undefined);
      }
      await asyncStorage.setItem(key, value);
    });
  }

  async function removeItem(key: string): Promise<void> {
    return withKeyQueue(key, async () => {
      if (!secureStoreUnavailable) {
        try {
          await removeSecureValue(key);
        } catch (error) {
          markSecureStoreUnavailable('remove', error);
        }
      }
      // Always clear the AsyncStorage copy too: legacy sessions and fallback
      // writes both live there.
      await asyncStorage.removeItem(key);
    });
  }

  return { getItem, setItem, removeItem };
}

export const secureSessionStorage = createSecureSessionStorage();
