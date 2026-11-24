import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const asyncStorage = vi.hoisted(() => ({ getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '0.1.9' } } }));

import { takeOffHomeShelf } from '@/lib/home-shelf-cache';
import { readHomeShelfItems } from '@/lib/home-shelf-view-model';
import {
  PERSISTED_HOME_SHELF_MAX_AGE_MS,
  PERSISTED_HOME_SHELF_STORAGE_KEY,
  PERSIST_HOME_SHELF_DEBOUNCE_MS,
  clearPersistedHomeShelf,
  createHomeShelfQueryKey,
  persistHomeShelf,
  resetPersistedHomeShelfForTests,
  restorePersistedHomeShelf,
  schedulePersistHomeShelf,
  toSavedShelfItems,
  type PersistedHomeShelfEnvironment,
} from '@/lib/persisted-home-shelf';
import type { HomeShelfCreation, HomeShelfItem, HomeShelfResponse, ShowcaseFeedItem } from '@/lib/types';

const FETCHED_AT = Date.parse('2026-11-24T08:00:00.000Z');
const APP_VERSION = '0.1.9';

function memoryStorage() {
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

type MemoryStorage = ReturnType<typeof memoryStorage>;

function environment(storage: MemoryStorage, now = FETCHED_AT + 60_000): PersistedHomeShelfEnvironment {
  return { storage, appVersion: APP_VERSION, now: () => now };
}

function post(id: string, creatorId = `creator-${id}`): ShowcaseFeedItem {
  return {
    id,
    mediaUrl: `https://project.supabase.co/storage/v1/object/public/showcase_media/posts/${id}/cover.webp`,
    mediaKind: 'image',
    mediaItems: [],
    model: 'manual',
    title: `Post ${id}`,
    prompt: '',
    body: '',
    category: 'image',
    postFormat: 'media',
    saveCount: 0,
    remixCount: 0,
    commentCount: 0,
    createdAt: '2026-11-20T10:00:00.000Z',
    creator: { id: creatorId, username: `maker-${id}`, name: 'Maker', avatar: null },
    generationId: `gen-${id}`,
    asset: null,
    canRemix: true,
  };
}

function creation(id: string, creatorId?: string): HomeShelfCreation {
  return {
    kind: 'creation',
    id,
    title: `Make ${id}`,
    tool: 'image',
    posterUrl: `https://project.supabase.co/storage/v1/object/public/showcase_media/posts/${id}/preview.webp`,
    posterThumbhash: null,
    clipUrl: null,
    modelName: 'Nano Banana',
    price: { kind: 'credits', credits: 15 },
    fitsWelcomeCredits: true,
    badge: id === 'a' ? 'new-model' : null,
    creator: { id: creatorId ?? `creator-${id}`, username: `maker-${id}`, name: 'Maker' },
    makeHref: `/create/image?remix=gen-${id}`,
    post: post(id, creatorId),
  };
}

function shelf(items: HomeShelfItem[] = [
  creation('a'),
  creation('b'),
  { kind: 'action', id: 'post' },
  creation('c'),
  creation('d'),
  { kind: 'action', id: 'invite', inviterPercent: 10, inviteePercent: 5 },
]): HomeShelfResponse {
  return { success: true, schemaVersion: 1, items };
}

function clientWithShelf(identity: string | null, data: HomeShelfResponse, updatedAt = FETCHED_AT) {
  const client = new QueryClient();
  client.setQueryData(createHomeShelfQueryKey(identity), data, { updatedAt });
  return client;
}

async function storageHolding(data: HomeShelfResponse, identity: string | null = 'user-1') {
  const storage = memoryStorage();
  await persistHomeShelf(clientWithShelf(identity, data), identity, environment(storage));
  resetPersistedHomeShelfForTests();
  return storage;
}

function saved(storage: MemoryStorage) {
  return JSON.parse(storage.values.get(PERSISTED_HOME_SHELF_STORAGE_KEY) ?? 'null');
}

const ids = (items: HomeShelfItem[] | undefined) => items?.map((item) => (item.kind === 'creation' ? item.id : `action:${item.id}`));

beforeEach(() => {
  resetPersistedHomeShelfForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the key', () => {
  it("is Home's own shelf key, per identity, guests included", () => {
    const dashboard = readFileSync(resolve(__dirname, '..', 'components/home-dashboard.tsx'), 'utf8');
    expect(dashboard).toContain("queryKey: ['home-shelf', identityUserId ?? 'signed-out'],");
    expect(createHomeShelfQueryKey('guest-1')).toEqual(['home-shelf', 'guest-1']);
    expect(createHomeShelfQueryKey(null)).toEqual(['home-shelf', 'signed-out']);
  });
});

describe('what a saved copy keeps', () => {
  it('keeps the creations without their price or "Free to try", and only the offer that names no figure', () => {
    const items = toSavedShelfItems(shelf().items);

    expect(ids(items)).toEqual(['a', 'b', 'action:post', 'c', 'd']);
    for (const item of items) {
      if (item.kind !== 'creation') continue;
      expect(item.price).toBeNull();
      expect(item.fitsWelcomeCredits).toBe(false);
    }
    // The launch badge is the pin's, not a figure, and stays.
    expect((items[0] as HomeShelfCreation).badge).toBe('new-model');
  });

  it('drops Earn, whose share is a figure', () => {
    const items = toSavedShelfItems([
      creation('a'), creation('b'), { kind: 'action', id: 'earn', creatorSharePercent: 80 }, creation('c'),
    ]);
    expect(ids(items)).toEqual(['a', 'b', 'c']);
  });

  it('keeps nothing when too few creations would be left to draw a shelf', () => {
    expect(toSavedShelfItems([creation('a'), creation('b'), { kind: 'action', id: 'post' }])).toEqual([]);
  });
});

describe('persistHomeShelf', () => {
  it('saves the shelf under the identity it was asked for', async () => {
    const storage = memoryStorage();
    await persistHomeShelf(clientWithShelf('guest-1', shelf()), 'guest-1', environment(storage));

    const copy = saved(storage);
    expect(copy).toMatchObject({ format: 1, appVersion: APP_VERSION, viewerUserId: 'guest-1', dataUpdatedAt: FETCHED_AT });
    expect(ids(copy.response.items)).toEqual(['a', 'b', 'action:post', 'c', 'd']);
  });

  it('saves nothing for a shelf that has not loaded, or has nothing to draw', async () => {
    const storage = memoryStorage();
    await persistHomeShelf(new QueryClient(), 'user-1', environment(storage));
    await persistHomeShelf(clientWithShelf('user-1', shelf([creation('a')])), 'user-1', environment(storage));
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('folds a fetch and the edits right after it into one write', async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const client = clientWithShelf('user-1', shelf());
    schedulePersistHomeShelf(client, 'user-1', environment(storage));
    schedulePersistHomeShelf(client, 'user-1', environment(storage));
    await vi.advanceTimersByTimeAsync(PERSIST_HOME_SHELF_DEBOUNCE_MS);
    expect(storage.setItem).toHaveBeenCalledOnce();
  });
});

describe('restorePersistedHomeShelf', () => {
  it('puts the shelf back under the same identity, and leaves no copy on the device', async () => {
    const storage = await storageHolding(shelf(), 'user-1');
    const client = new QueryClient();

    await expect(restorePersistedHomeShelf(client, environment(storage))).resolves.toBe(true);

    const restored = client.getQueryData<HomeShelfResponse>(createHomeShelfQueryKey('user-1'));
    expect(ids(readHomeShelfItems(restored))).toEqual(['a', 'b', 'action:post', 'c', 'd']);
    expect(storage.values.has(PERSISTED_HOME_SHELF_STORAGE_KEY)).toBe(false);
  });

  it('is written back by the save Home makes once it draws it, so a failed refetch still leaves a copy', async () => {
    const storage = await storageHolding(shelf(), 'user-1');
    const client = new QueryClient();
    await restorePersistedHomeShelf(client, environment(storage));
    expect(storage.values.has(PERSISTED_HOME_SHELF_STORAGE_KEY)).toBe(false);

    // The restored answer is a success with data: Home's save effect writes it again.
    await persistHomeShelf(client, 'user-1', environment(storage));

    expect(saved(storage)).toMatchObject({ viewerUserId: 'user-1', dataUpdatedAt: FETCHED_AT });
    const next = new QueryClient();
    await expect(restorePersistedHomeShelf(next, environment(storage))).resolves.toBe(true);
  });

  it('never under another identity, or none: another identity draws bones', async () => {
    const storage = await storageHolding(shelf(), 'guest-1');
    const client = new QueryClient();

    await restorePersistedHomeShelf(client, environment(storage));

    expect(client.getQueryData(createHomeShelfQueryKey('guest-1'))).toBeDefined();
    expect(client.getQueryData(createHomeShelfQueryKey('user-2'))).toBeUndefined();
    expect(client.getQueryData(createHomeShelfQueryKey(null))).toBeUndefined();
  });

  it('keeps the age it was fetched at, and is stale even when saved a minute ago, so a refetch follows', async () => {
    const storage = await storageHolding(shelf(), 'user-1');
    const client = new QueryClient();
    await restorePersistedHomeShelf(client, environment(storage, FETCHED_AT + 60_000));

    const queryKey = createHomeShelfQueryKey('user-1');
    expect(client.getQueryState(queryKey)?.dataUpdatedAt).toBe(FETCHED_AT);

    // Home's own options: five minutes of staleTime would otherwise skip the read.
    const queryFn = vi.fn(async () => shelf([creation('x'), creation('y'), creation('z')]));
    const observer = new QueryObserver(client, { queryKey, queryFn, staleTime: 5 * 60 * 1000 });
    expect(observer.getCurrentResult().isStale).toBe(true);
    const unsubscribe = observer.subscribe(() => undefined);
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(ids(client.getQueryData<HomeShelfResponse>(queryKey)?.items)).toEqual(['x', 'y', 'z']));
    unsubscribe();
  });

  it('does not restore a copy past its age, from the future, from another build or format', async () => {
    const storage = await storageHolding(shelf(), 'user-1');
    const copy = storage.values.get(PERSISTED_HOME_SHELF_STORAGE_KEY)!;
    const tries: Array<[string, number]> = [
      [copy, FETCHED_AT + PERSISTED_HOME_SHELF_MAX_AGE_MS + 1],
      [copy, FETCHED_AT - 5 * 60_000],
      [JSON.stringify({ ...JSON.parse(copy), appVersion: '0.1.8' }), FETCHED_AT + 60_000],
      [JSON.stringify({ ...JSON.parse(copy), format: 2 }), FETCHED_AT + 60_000],
      ['{not json', FETCHED_AT + 60_000],
    ];
    for (const [value, now] of tries) {
      storage.values.set(PERSISTED_HOME_SHELF_STORAGE_KEY, value);
      const client = new QueryClient();
      await expect(restorePersistedHomeShelf(client, environment(storage, now))).resolves.toBe(false);
      expect(client.getQueryData(createHomeShelfQueryKey('user-1'))).toBeUndefined();
      expect(storage.values.has(PERSISTED_HOME_SHELF_STORAGE_KEY)).toBe(false);
    }
  });

  it('a copy that holds a price or an Invite offer (an older build) comes back without them', async () => {
    const storage = memoryStorage();
    storage.values.set(PERSISTED_HOME_SHELF_STORAGE_KEY, JSON.stringify({
      format: 1, appVersion: APP_VERSION, viewerUserId: 'user-1', dataUpdatedAt: FETCHED_AT, response: shelf(),
    }));
    const client = new QueryClient();
    await restorePersistedHomeShelf(client, environment(storage));

    const items = client.getQueryData<HomeShelfResponse>(createHomeShelfQueryKey('user-1'))?.items ?? [];
    expect(ids(items)).toEqual(['a', 'b', 'action:post', 'c', 'd']);
    expect(items.every((item) => item.kind !== 'creation' || item.price === null)).toBe(true);
  });

  it('never replaces an answer this launch already has', async () => {
    const storage = await storageHolding(shelf(), 'user-1');
    const fresh = shelf([creation('x'), creation('y'), creation('z')]);
    const client = clientWithShelf('user-1', fresh, FETCHED_AT + 30_000);

    await expect(restorePersistedHomeShelf(client, environment(storage))).resolves.toBe(false);
    expect(client.getQueryData(createHomeShelfQueryKey('user-1'))).toBe(fresh);
  });
});

describe('a card taken off', () => {
  it('drops the saved copy at once, and the edited shelf saved after leaves the card off next launch', async () => {
    const storage = await storageHolding(shelf(), 'user-1');
    asyncStorage.removeItem.mockImplementation(storage.removeItem);
    const client = clientWithShelf('user-1', shelf(), FETCHED_AT);

    takeOffHomeShelf(client, { creatorId: 'creator-b' });
    await clearPersistedHomeShelf(environment(storage)); // waits for the queued removal
    expect(storage.values.has(PERSISTED_HOME_SHELF_STORAGE_KEY)).toBe(false);

    // What Home's save does after the edit.
    await persistHomeShelf(client, 'user-1', environment(storage));
    const next = new QueryClient();
    await restorePersistedHomeShelf(next, environment(storage, Date.now() + 1000));
    expect(ids(next.getQueryData<HomeShelfResponse>(createHomeShelfQueryKey('user-1'))?.items))
      .toEqual(['a', 'action:post', 'c', 'd']);
  });
});

describe('clearPersistedHomeShelf', () => {
  it('cancels a pending save and forgets the copy', async () => {
    vi.useFakeTimers();
    const storage = await storageHolding(shelf(), 'user-1');
    schedulePersistHomeShelf(clientWithShelf('user-1', shelf()), 'user-1', environment(storage));
    await clearPersistedHomeShelf(environment(storage));
    await vi.advanceTimersByTimeAsync(PERSIST_HOME_SHELF_DEBOUNCE_MS * 2);
    expect(storage.values.has(PERSISTED_HOME_SHELF_STORAGE_KEY)).toBe(false);
  });
});

describe('wiring', () => {
  const read = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');

  it('restores from the eagerly loaded root layout, next to the feed', () => {
    const layout = read('app/_layout.tsx');
    const clientAt = layout.indexOf('const queryClient = new QueryClient(');
    expect(layout.indexOf('void restorePersistedHomeShelf(queryClient);')).toBeGreaterThan(clientAt);
  });

  it('saves from Home once auth has settled, under the backend identity', () => {
    const dashboard = read('components/home-dashboard.tsx');
    expect(dashboard).toContain('if (isAuthLoading || !shelfQuery.isSuccess) return;');
    expect(dashboard).toContain('schedulePersistHomeShelf(queryClient, identityUserId);');
    expect(dashboard).toContain('useEffect(() => cancelScheduledPersistHomeShelf, []);');
  });

  it('forgets the saved shelf everywhere the signed-in session is cleared from the device', () => {
    const auth = read('lib/auth.tsx');
    const count = (needle: string) => auth.split(needle).length - 1;
    expect(count('clearPersistedSupabaseAuthSession()')).toBeGreaterThan(0);
    expect(count('clearPersistedHomeShelf()')).toBe(count('clearPersistedSupabaseAuthSession()'));
  });
});
