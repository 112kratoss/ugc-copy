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
  it('keeps reports across a launch, and lets go only of the ones it is told were sent', async () => {
    const store = createClientErrorStore();
    await store.save([report('a')]);
    await store.save([report('b')]);

    const next = createClientErrorStore();
    const kept = await next.peek();
    expect(kept.map((body) => body.message)).toEqual(['a', 'b']);
    // Offline at this launch: nothing was sent, and both wait for the next.
    expect((await next.peek()).map((body) => body.message)).toEqual(['a', 'b']);
    await next.drop([kept[0]]);
    expect((await next.peek()).map((body) => body.message)).toEqual(['b']);
    await next.drop([kept[1]]);
    expect(await next.peek()).toEqual([]);
    expect(storage.values.has(CLIENT_ERROR_STORE_KEY)).toBe(false);
  });

  it('keeps five at most, reads anything unreadable as nothing, and never throws', async () => {
    const store = createClientErrorStore();
    for (let index = 0; index < 8; index += 1) await store.save([report(`e${index}`)]);
    expect((await store.peek()).map((body) => body.message)).toEqual(['e3', 'e4', 'e5', 'e6', 'e7']);

    storage.values.set(CLIENT_ERROR_STORE_KEY, '{not json');
    expect(await store.peek()).toEqual([]);
    storage.getItem.mockRejectedValueOnce(new Error('disk'));
    expect(await store.peek()).toEqual([]);
    storage.getItem.mockRejectedValueOnce(new Error('disk'));
    await expect(store.drop([report('x')])).resolves.toBeUndefined();
  });
});
