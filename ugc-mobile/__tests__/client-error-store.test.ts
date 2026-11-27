import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    values,
    getItem: vi.fn(async (key: string) => values.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn(async (key: string) => { values.delete(key); }),
  };
});
vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage }));

import { CLIENT_ERROR_STORE_KEY, createClientErrorStore } from '../lib/client-error-store';

const report = (message: string) => ({
  message,
  stack: null,
  componentStack: null,
  fatal: true,
  route: '/',
  appVersion: '0.1.9',
  updateId: null,
  platform: 'ios' as const,
});

beforeEach(() => {
  storage.values.clear();
  vi.clearAllMocks();
});

// A fatal error's report waits on the device for the next launch (audit 2026-11-27 review, E).
describe('the client error store', () => {
  it('keeps reports across a launch and hands them over once', async () => {
    const store = createClientErrorStore();
    await store.save([report('a')]);
    await store.save([report('b')]);

    const next = createClientErrorStore();
    expect((await next.take()).map((body) => body.message)).toEqual(['a', 'b']);
    expect(await next.take()).toEqual([]);
    expect(storage.values.has(CLIENT_ERROR_STORE_KEY)).toBe(false);
  });

  it('keeps five at most, and reads anything unreadable as nothing', async () => {
    const store = createClientErrorStore();
    for (let index = 0; index < 8; index += 1) await store.save([report(`e${index}`)]);
    expect((await store.take()).map((body) => body.message)).toEqual(['e3', 'e4', 'e5', 'e6', 'e7']);

    storage.values.set(CLIENT_ERROR_STORE_KEY, '{not json');
    expect(await store.take()).toEqual([]);
    storage.getItem.mockRejectedValueOnce(new Error('disk'));
    expect(await store.take()).toEqual([]);
  });
});
