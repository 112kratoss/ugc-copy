import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

// Supabase auth sessions previously persisted to plaintext AsyncStorage. This
// adapter keeps refresh tokens in the device keychain/keystore and performs a
// one-way migration of legacy sessions. AsyncStorage is never an auth-session
// fallback: if secure persistence is unavailable or corrupt, the legacy copy
// is erased and the session is invalidated.
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
    removeItem: (key: string) => Promise<void>;
  };
  warn: (message: string, error?: unknown) => void;
  invalidateSession: (reason: SecureSessionInvalidationReason) => void;
};

export type SecureSessionInvalidationReason =
  | 'corrupt-secure-value'
  | 'legacy-migration-failed'
  | 'secure-store-unavailable'
  | 'secure-value-too-large';

export class SecureSessionStorageError extends Error {
  readonly code = 'SECURE_SESSION_STORAGE_UNAVAILABLE';

  constructor(
    message: string,
    readonly reason: SecureSessionInvalidationReason,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'SecureSessionStorageError';
  }
}

let secureSessionInvalidationHandler: ((reason: SecureSessionInvalidationReason) => void) | null = null;

/**
 * Connects storage fail-closed events to the auth client's local sign-out.
 * The returned disposer is mainly useful for tests and hot reload cleanup.
 */
export function configureSecureSessionInvalidationHandler(
  handler: ((reason: SecureSessionInvalidationReason) => void) | null,
) {
  secureSessionInvalidationHandler = handler;
  return () => {
    if (secureSessionInvalidationHandler === handler) {
      secureSessionInvalidationHandler = null;
    }
  };
}

const defaultDependencies: SecureSessionStorageDependencies = {
  secureStore: {
    getItemAsync: (key) => SecureStore.getItemAsync(key),
    setItemAsync: (key, value) => SecureStore.setItemAsync(key, value),
    deleteItemAsync: (key) => SecureStore.deleteItemAsync(key),
  },
  asyncStorage: {
    getItem: (key) => AsyncStorage.getItem(key),
    removeItem: (key) => AsyncStorage.removeItem(key),
  },
  warn: (message, error) => {
    console.warn(message, error);
  },
  invalidateSession: (reason) => {
    secureSessionInvalidationHandler?.(reason);
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

function parseChunkCount(rawMeta: string): number | null {
  const count = Number.parseInt(rawMeta, 10);
  if (!Number.isInteger(count) || String(count) !== rawMeta.trim() || count < 1 || count > MAX_CHUNKS) {
    return null;
  }
  return count;
}

class CorruptSecureValueError extends Error {
  constructor() {
    super('Secure session chunks are incomplete or have invalid metadata.');
    this.name = 'CorruptSecureValueError';
  }
}

export function createSecureSessionStorage(
  overrides: Partial<SecureSessionStorageDependencies> = {}
): SecureSessionStorage {
  const { secureStore, asyncStorage, warn, invalidateSession } = {
    ...defaultDependencies,
    ...overrides,
  };
  const keyQueues = new Map<string, Promise<unknown>>();

  /** Serializes operations per key so chunked writes never interleave. */
  function withKeyQueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = keyQueues.get(key) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    keyQueues.set(key, next.then(() => undefined, () => undefined));
    return next;
  }

  async function readChunkCount(key: string): Promise<number | null> {
    const rawMeta = await secureStore.getItemAsync(metaKey(key));
    if (rawMeta === null) return null;
    const chunkCount = parseChunkCount(rawMeta);
    if (chunkCount === null) throw new CorruptSecureValueError();
    return chunkCount;
  }

  async function readSecureValue(key: string): Promise<string | null> {
    const chunkCount = await readChunkCount(key);
    if (chunkCount === null) {
      // A chunk without its commit marker is an interrupted/corrupt write, not
      // an empty storage slot. Never revive a plaintext fallback over it.
      if (await secureStore.getItemAsync(chunkKey(key, 0)) !== null) {
        throw new CorruptSecureValueError();
      }
      return null;
    }
    const chunks = await Promise.all(
      Array.from({ length: chunkCount }, (_, index) => secureStore.getItemAsync(chunkKey(key, index)))
    );
    if (chunks.some((chunk) => chunk === null)) throw new CorruptSecureValueError();
    return chunks.join('');
  }

  /** Returns false when the value cannot be represented (too many chunks). */
  async function writeSecureValue(key: string, value: string): Promise<boolean> {
    const chunks = splitValueIntoChunks(value);
    if (chunks.length > MAX_CHUNKS) return false;
    const previousCount = await readChunkCount(key);
    // Invalidate the old value before overwriting any live chunk. If the app is
    // terminated during the rewrite, a later read sees orphaned chunks without
    // a commit marker and fails closed instead of joining new and old chunks.
    await secureStore.deleteItemAsync(metaKey(key));
    for (let index = 0; index < chunks.length; index += 1) {
      await secureStore.setItemAsync(chunkKey(key, index), chunks[index]);
    }
    // The metadata entry is the commit marker and must always be published
    // after every chunk is durable.
    await secureStore.setItemAsync(metaKey(key), String(chunks.length));
    if (previousCount !== null) {
      for (let index = chunks.length; index < previousCount; index += 1) {
        await secureStore.deleteItemAsync(chunkKey(key, index));
      }
    }
    return true;
  }

  async function removeSecureValue(key: string) {
    const rawMeta = await secureStore.getItemAsync(metaKey(key));
    const knownCount = rawMeta === null ? 0 : (parseChunkCount(rawMeta) ?? 0);
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

  function reasonForReadFailure(error: unknown): SecureSessionInvalidationReason {
    return error instanceof CorruptSecureValueError
      ? 'corrupt-secure-value'
      : 'secure-store-unavailable';
  }

  async function invalidateUnsafeValue(
    key: string,
    reason: SecureSessionInvalidationReason,
    error?: unknown,
  ) {
    // Plaintext cleanup is attempted first. Even if SecureStore itself is
    // broken, a legacy bearer token must not remain available to backups or
    // other code paths.
    try {
      await asyncStorage.removeItem(key);
    } catch (cleanupError) {
      warn('Failed to erase a legacy plaintext auth session.', cleanupError);
    }

    try {
      await removeSecureValue(key);
    } catch (cleanupError) {
      warn('Failed to erase an invalid secure auth session.', cleanupError);
    }

    const messages: Record<SecureSessionInvalidationReason, string> = {
      'corrupt-secure-value': 'Secure session data is corrupt; signing out.',
      'legacy-migration-failed': 'Legacy auth session migration failed; signing out.',
      'secure-store-unavailable': 'SecureStore is unavailable; signing out.',
      'secure-value-too-large': 'Auth session exceeds secure storage capacity; signing out.',
    };
    warn(messages[reason], error);
    try {
      invalidateSession(reason);
    } catch (invalidationError) {
      warn('Failed to notify the auth client about invalid secure session state.', invalidationError);
    }
  }

  async function migrateLegacyValue(key: string, legacyValue: string): Promise<string | null> {
    let stored = false;
    try {
      stored = await writeSecureValue(key, legacyValue);
      if (!stored) {
        await invalidateUnsafeValue(key, 'secure-value-too-large');
        return null;
      }
      if ((await readSecureValue(key)) !== legacyValue) {
        await invalidateUnsafeValue(key, 'corrupt-secure-value');
        return null;
      }
    } catch (error) {
      await invalidateUnsafeValue(key, reasonForReadFailure(error), error);
      return null;
    }

    try {
      await asyncStorage.removeItem(key);
    } catch (error) {
      await invalidateUnsafeValue(key, 'legacy-migration-failed', error);
      return null;
    }
    return legacyValue;
  }

  async function getItem(key: string): Promise<string | null> {
    return withKeyQueue(key, async () => {
      let secureValue: string | null;
      try {
        secureValue = await readSecureValue(key);
      } catch (error) {
        await invalidateUnsafeValue(key, reasonForReadFailure(error), error);
        return null;
      }

      if (secureValue !== null) {
        // A successful secure read also self-heals any leftover plaintext copy.
        // Failure to erase that copy is unsafe, so fail closed rather than
        // returning a refresh token while plaintext persistence remains.
        try {
          await asyncStorage.removeItem(key);
        } catch (error) {
          await invalidateUnsafeValue(key, 'legacy-migration-failed', error);
          return null;
        }
        return secureValue;
      }

      let legacyValue: string | null;
      try {
        legacyValue = await asyncStorage.getItem(key);
      } catch (error) {
        await invalidateUnsafeValue(key, 'legacy-migration-failed', error);
        return null;
      }
      if (legacyValue === null) return null;
      return migrateLegacyValue(key, legacyValue);
    });
  }

  async function setItem(key: string, value: string): Promise<void> {
    return withKeyQueue(key, async () => {
      let stored = false;
      try {
        stored = await writeSecureValue(key, value);
      } catch (error) {
        const reason = reasonForReadFailure(error);
        await invalidateUnsafeValue(key, reason, error);
        throw new SecureSessionStorageError(
          'Secure session storage is unavailable. Sign in again after secure storage recovers.',
          reason,
          { cause: error },
        );
      }
      if (!stored) {
        await invalidateUnsafeValue(key, 'secure-value-too-large');
        throw new SecureSessionStorageError(
          'Auth session is too large for secure storage.',
          'secure-value-too-large',
        );
      }

      try {
        // Self-heal any lingering plaintext copy from the pre-SecureStore era.
        await asyncStorage.removeItem(key);
      } catch (error) {
        await invalidateUnsafeValue(key, 'legacy-migration-failed', error);
        throw new SecureSessionStorageError(
          'Could not erase the legacy plaintext auth session.',
          'legacy-migration-failed',
          { cause: error },
        );
      }
    });
  }

  async function removeItem(key: string): Promise<void> {
    return withKeyQueue(key, async () => {
      try {
        await removeSecureValue(key);
      } catch (error) {
        // Sign-out must still complete in memory when the keystore is broken.
        warn('Failed to erase a secure auth session during sign-out.', error);
      }
      try {
        await asyncStorage.removeItem(key);
      } catch (error) {
        warn('Failed to erase a legacy plaintext auth session during sign-out.', error);
      }
    });
  }

  return { getItem, setItem, removeItem };
}

/** A deliberately process-local storage adapter for the Expo web target. */
export function createMemorySessionStorage(): SecureSessionStorage {
  const values = new Map<string, string>();
  return {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      values.set(key, value);
    },
    removeItem: async (key) => {
      values.delete(key);
    },
  };
}

export const secureSessionStorage = createSecureSessionStorage();
