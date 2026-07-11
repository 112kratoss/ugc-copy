import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('expo-crypto', () => ({
  getRandomBytesAsync: vi.fn(),
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));

import {
  getFeedInstallationId,
  isValidFeedInstallationId,
  resetFeedInstallationIdCacheForTests,
} from '../lib/feed-installation-id';

describe('mobile feed installation identity', () => {
  beforeEach(() => resetFeedInstallationIdCacheForTests());

  it('persists a cryptographically generated 256-bit identifier', async () => {
    const setItem = vi.fn(async () => undefined);
    const dependencies = {
      getItem: vi.fn(async () => null),
      getRandomBytes: vi.fn(async () => new Uint8Array(Array.from({ length: 32 }, (_, index) => index))),
      setItem,
    };

    const installationId = await getFeedInstallationId(dependencies);

    expect(installationId).toBe(`fid_${Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(2, '0')).join('')}`);
    expect(isValidFeedInstallationId(installationId)).toBe(true);
    expect(setItem).toHaveBeenCalledWith(expect.any(String), installationId);
  });

  it('reuses valid secure storage and coalesces concurrent reads', async () => {
    const stored = `fid_${'b'.repeat(64)}`;
    const getItem = vi.fn(async () => stored);
    const dependencies = {
      getItem,
      getRandomBytes: vi.fn(),
      setItem: vi.fn(),
    };

    await expect(Promise.all([
      getFeedInstallationId(dependencies),
      getFeedInstallationId(dependencies),
    ])).resolves.toEqual([stored, stored]);
    expect(getItem).toHaveBeenCalledTimes(1);
    expect(dependencies.getRandomBytes).not.toHaveBeenCalled();
  });

  it('does not emit a weak ephemeral ID when secure persistence fails', async () => {
    const dependencies = {
      getItem: vi.fn(async () => null),
      getRandomBytes: vi.fn(async () => new Uint8Array(32)),
      setItem: vi.fn(async () => { throw new Error('SecureStore unavailable'); }),
    };

    await expect(getFeedInstallationId(dependencies)).resolves.toBeNull();
  });
});
