import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

const FEED_INSTALLATION_ID_STORAGE_KEY = 'magicbooklet.feed.installationId.v1';
const FEED_INSTALLATION_ID_PATTERN = /^fid_[a-f0-9]{64}$/;

type FeedInstallationIdDependencies = {
  getItem: (key: string) => Promise<string | null>;
  getRandomBytes: (byteCount: number) => Promise<Uint8Array>;
  setItem: (key: string, value: string) => Promise<void>;
};

const defaultDependencies: FeedInstallationIdDependencies = {
  getItem: (key) => SecureStore.getItemAsync(key),
  getRandomBytes: (byteCount) => Crypto.getRandomBytesAsync(byteCount),
  setItem: (key, value) => SecureStore.setItemAsync(key, value),
};

let cachedInstallationId: string | null = null;
let installationIdPromise: Promise<string | null> | null = null;

export function isValidFeedInstallationId(value: string | null | undefined): value is string {
  return typeof value === 'string' && FEED_INSTALLATION_ID_PATTERN.test(value);
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function loadOrCreateFeedInstallationId(
  dependencies: FeedInstallationIdDependencies
): Promise<string | null> {
  try {
    const existing = await dependencies.getItem(FEED_INSTALLATION_ID_STORAGE_KEY);
    if (isValidFeedInstallationId(existing)) return existing;

    const bytes = await dependencies.getRandomBytes(32);
    if (bytes.length !== 32) return null;
    const generated = `fid_${bytesToHex(bytes)}`;
    if (!isValidFeedInstallationId(generated)) return null;
    await dependencies.setItem(FEED_INSTALLATION_ID_STORAGE_KEY, generated);
    return generated;
  } catch {
    return null;
  }
}

export async function getFeedInstallationId(
  dependencies: FeedInstallationIdDependencies = defaultDependencies
) {
  if (cachedInstallationId) return cachedInstallationId;
  if (!installationIdPromise) {
    installationIdPromise = loadOrCreateFeedInstallationId(dependencies)
      .then((installationId) => {
        cachedInstallationId = installationId;
        return installationId;
      })
      .finally(() => {
        installationIdPromise = null;
      });
  }
  return installationIdPromise;
}

export function resetFeedInstallationIdCacheForTests() {
  cachedInstallationId = null;
  installationIdPromise = null;
}
