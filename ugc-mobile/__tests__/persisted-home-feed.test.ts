import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '0.1.4' } } }));

import { HOME_FEED_CHIPS } from '@/lib/home-feed-view-model';
import {
  PERSISTED_HOME_FEED_CHIP_ID,
  PERSISTED_HOME_FEED_MAX_AGE_MS,
  PERSISTED_HOME_FEED_STORAGE_KEY,
  PERSIST_HOME_FEED_DEBOUNCE_MS,
  cancelScheduledPersistHomeFeed,
  clearPersistedHomeFeed,
  createPersistedHomeFeedQueryKey,
  isPersistedHomeFeedData,
  persistHomeFeed,
  resetPersistedHomeFeedForTests,
  restorePersistedHomeFeed,
  schedulePersistHomeFeed,
  type PersistedHomeFeedEnvironment,
} from '@/lib/persisted-home-feed';
import {
  SHOWCASE_FEED_STALE_TIME_MS,
  createShowcaseFeedQueryKey,
  type ShowcaseFeedPageParam,
} from '@/lib/showcase-feed-query';
import type { ShowcaseFeedItem, ShowcaseFeedResponse } from '@/lib/types';

type HomeFeedData = InfiniteData<ShowcaseFeedResponse, ShowcaseFeedPageParam>;

const FETCHED_AT = Date.parse('2026-09-12T08:00:00.000Z');
const APP_VERSION = '0.1.4';

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

function environment(storage: MemoryStorage, now = FETCHED_AT + 60_000): PersistedHomeFeedEnvironment {
  return { storage, appVersion: APP_VERSION, now: () => now };
}

function post(id: string, overrides: Partial<ShowcaseFeedItem> = {}): ShowcaseFeedItem {
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
    createdAt: '2026-09-11T10:00:00.000Z',
    creator: { id: 'creator-1', username: 'luna', name: 'Luna', avatar: null },
    generationId: null,
    asset: null,
    canRemix: false,
    ...overrides,
  };
}

function feedPage(ids: string[]): ShowcaseFeedResponse {
  return {
    items: ids.map((id) => post(id)),
    feedSessionId: 'session-1',
    nextCursor: `after-${ids.join('-')}`,
    pageInfo: { hasMore: true },
  };
}

function lane(...pages: string[][]): HomeFeedData {
  return {
    pages: pages.map(feedPage),
    pageParams: pages.map((_, index) => (
      index === 0 ? { offset: 0 } : { cursor: `after-${pages[index - 1].join('-')}`, feedSessionId: 'session-1' }
    )),
  };
}

function clientWithLane(viewerUserId: string | null, data: HomeFeedData, updatedAt = FETCHED_AT) {
  const client = new QueryClient();
  client.setQueryData(createPersistedHomeFeedQueryKey(viewerUserId), data, { updatedAt });
  return client;
}

/** What the next launch finds: the page on disk, and nothing in memory. */
async function storageHolding(data: HomeFeedData, viewerUserId: string | null = 'user-1') {
  const storage = memoryStorage();
  await persistHomeFeed(clientWithLane(viewerUserId, data), viewerUserId, environment(storage));
  resetPersistedHomeFeedForTests();
  vi.clearAllMocks();
  return storage;
}

function storedCopy(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    format: 1,
    appVersion: APP_VERSION,
    viewerUserId: 'user-1',
    dataUpdatedAt: FETCHED_AT,
    page: feedPage(['a']),
    pageParam: { offset: 0 },
    ...overrides,
  });
}

function savedIds(storage: MemoryStorage) {
  const saved = JSON.parse(storage.values.get(PERSISTED_HOME_FEED_STORAGE_KEY) ?? 'null');
  return saved?.page.items.map((item: ShowcaseFeedItem) => item.id);
}

beforeEach(() => {
  resetPersistedHomeFeedForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the persisted lane', () => {
  it("is the For You lane home opens on, under each viewer's own key", () => {
    const forYou = HOME_FEED_CHIPS.find((chip) => chip.id === 'for-you');

    expect(PERSISTED_HOME_FEED_CHIP_ID).toBe('for-you');
    expect(createPersistedHomeFeedQueryKey('user-1')).toEqual(createShowcaseFeedQueryKey(forYou?.filters, 'user-1'));
    expect(createPersistedHomeFeedQueryKey(null)).toEqual(createShowcaseFeedQueryKey(forYou?.filters, null));
  });
});

describe('persistHomeFeed', () => {
  it('saves the first page only, with the page param it was fetched from', async () => {
    const storage = memoryStorage();
    const client = clientWithLane('user-1', lane(['a', 'b'], ['c'], ['d']));

    await persistHomeFeed(client, 'user-1', environment(storage));

    const saved = JSON.parse(storage.values.get(PERSISTED_HOME_FEED_STORAGE_KEY) ?? 'null');
    expect(saved).toMatchObject({ viewerUserId: 'user-1', dataUpdatedAt: FETCHED_AT, pageParam: { offset: 0 } });
    expect(savedIds(storage)).toEqual(['a', 'b']);
  });

  it('saves nothing for a lane that has not loaded, or that holds no posts', async () => {
    const storage = memoryStorage();

    await persistHomeFeed(new QueryClient(), 'user-1', environment(storage));
    await persistHomeFeed(clientWithLane('user-1', lane([])), 'user-1', environment(storage));

    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('skips the write when the page has not changed since the last one', async () => {
    const storage = memoryStorage();
    const client = clientWithLane(null, lane(['a']));

    await persistHomeFeed(client, null, environment(storage));
    await persistHomeFeed(client, null, environment(storage));
    expect(storage.setItem).toHaveBeenCalledOnce();

    client.setQueryData<HomeFeedData>(
      createPersistedHomeFeedQueryKey(null),
      (current) => current && { ...current, pages: [{ ...current.pages[0], items: [post('a', { isSaved: true })] }] },
      { updatedAt: FETCHED_AT + 5_000 },
    );
    await persistHomeFeed(client, null, environment(storage));
    expect(storage.setItem).toHaveBeenCalledTimes(2);
  });
});

describe('restorePersistedHomeFeed', () => {
  it("puts the page back under its viewer's key, as old as when it was fetched", async () => {
    const storage = await storageHolding(lane(['a', 'b']));
    const client = new QueryClient();
    const tenMinutesOn = FETCHED_AT + 10 * 60_000;
    vi.useFakeTimers();
    vi.setSystemTime(tenMinutesOn);

    await expect(restorePersistedHomeFeed(client, environment(storage, tenMinutesOn))).resolves.toBe(true);

    const queryKey = createPersistedHomeFeedQueryKey('user-1');
    const state = client.getQueryState<HomeFeedData>(queryKey);
    expect(state?.data?.pages.map((page) => page.items.map((item) => item.id))).toEqual([['a', 'b']]);
    expect(state?.data?.pageParams).toEqual([{ offset: 0 }]);
    expect(state?.dataUpdatedAt).toBe(FETCHED_AT);
    // Past the lane's staleTime, so home refetches the moment it mounts.
    expect(client.getQueryCache().find({ queryKey })?.isStaleByTime(SHOWCASE_FEED_STALE_TIME_MS)).toBe(true);
  });

  it('counts as fresh inside the staleTime, the same as a return from the background', async () => {
    const storage = await storageHolding(lane(['a']));
    const client = new QueryClient();
    const twoMinutesOn = FETCHED_AT + 2 * 60_000;
    vi.useFakeTimers();
    vi.setSystemTime(twoMinutesOn);

    await restorePersistedHomeFeed(client, environment(storage, twoMinutesOn));

    const queryKey = createPersistedHomeFeedQueryKey('user-1');
    expect(client.getQueryCache().find({ queryKey })?.isStaleByTime(SHOWCASE_FEED_STALE_TIME_MS)).toBe(false);
  });

  it('takes the saved copy off the device before the page is drawn', async () => {
    const storage = await storageHolding(lane(['a']));

    await restorePersistedHomeFeed(new QueryClient(), environment(storage));

    expect(storage.values.has(PERSISTED_HOME_FEED_STORAGE_KEY)).toBe(false);
  });

  it('never replaces posts this launch has already fetched', async () => {
    const storage = await storageHolding(lane(['saved']));
    const client = clientWithLane('user-1', lane(['fresh']), FETCHED_AT + 60_000);

    await expect(restorePersistedHomeFeed(client, environment(storage))).resolves.toBe(false);

    const data = client.getQueryData<HomeFeedData>(createPersistedHomeFeedQueryKey('user-1'));
    expect(data?.pages[0]?.items.map((item) => item.id)).toEqual(['fresh']);
  });

  it('fills a lane whose first request is still out, and leaves the request running', async () => {
    const storage = await storageHolding(lane(['a']));
    const client = new QueryClient();
    const queryKey = createPersistedHomeFeedQueryKey('user-1');
    void client.fetchInfiniteQuery({
      queryKey,
      initialPageParam: { offset: 0 } as ShowcaseFeedPageParam,
      queryFn: () => new Promise<ShowcaseFeedResponse>(() => undefined),
      getNextPageParam: () => null,
    });

    await restorePersistedHomeFeed(client, environment(storage));

    const state = client.getQueryState<HomeFeedData>(queryKey);
    expect(state).toMatchObject({ status: 'success', fetchStatus: 'fetching' });
    expect(state?.data?.pages[0]?.items.map((item) => item.id)).toEqual(['a']);
  });

  it.each([
    ['a copy saved by another app version', storedCopy({ appVersion: '0.1.3' }), FETCHED_AT],
    ['a copy in a format this build does not know', storedCopy({ format: 2 }), FETCHED_AT],
    ['posts older than the age limit', storedCopy(), FETCHED_AT + PERSISTED_HOME_FEED_MAX_AGE_MS + 1],
    ['posts dated after the device clock', storedCopy(), FETCHED_AT - 10 * 60_000],
    ['a copy cut off mid-write', storedCopy().slice(0, 80), FETCHED_AT],
    ['a post with no id', storedCopy({ page: { items: [{ ...post('a'), id: undefined }] } }), FETCHED_AT],
    ['a post with no creator', storedCopy({ page: { items: [{ ...post('a'), creator: null }] } }), FETCHED_AT],
    ['a page with no posts', storedCopy({ page: { items: [] } }), FETCHED_AT],
    ['a page param it cannot fetch from', storedCopy({ pageParam: { offset: 'first' } }), FETCHED_AT],
    ['a blank viewer', storedCopy({ viewerUserId: ' ' }), FETCHED_AT],
  ])('drops %s, and the copy with it', async (_label, stored, now) => {
    const storage = memoryStorage();
    storage.values.set(PERSISTED_HOME_FEED_STORAGE_KEY, stored);
    const client = new QueryClient();

    await expect(restorePersistedHomeFeed(client, environment(storage, now))).resolves.toBe(false);

    expect(client.getQueryCache().getAll()).toEqual([]);
    expect(storage.values.has(PERSISTED_HOME_FEED_STORAGE_KEY)).toBe(false);
  });
});

describe('scheduled saves and clearing', () => {
  it('folds a burst of changes into one write of the latest page', async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const client = clientWithLane('user-1', lane(['a']));
    const queryKey = createPersistedHomeFeedQueryKey('user-1');

    schedulePersistHomeFeed(client, 'user-1', environment(storage));
    client.setQueryData<HomeFeedData>(queryKey, lane(['b']));
    schedulePersistHomeFeed(client, 'user-1', environment(storage));
    client.setQueryData<HomeFeedData>(queryKey, lane(['c']));
    schedulePersistHomeFeed(client, 'user-1', environment(storage));
    await vi.advanceTimersByTimeAsync(PERSIST_HOME_FEED_DEBOUNCE_MS);

    await vi.waitFor(() => expect(storage.setItem).toHaveBeenCalledOnce());
    expect(savedIds(storage)).toEqual(['c']);
  });

  it('drops a waiting save when it is cancelled', async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();

    schedulePersistHomeFeed(clientWithLane('user-1', lane(['a'])), 'user-1', environment(storage));
    cancelScheduledPersistHomeFeed();
    await vi.advanceTimersByTimeAsync(PERSIST_HOME_FEED_DEBOUNCE_MS * 2);

    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('removes the saved page and cancels a save still waiting to run', async () => {
    vi.useFakeTimers();
    const storage = await storageHolding(lane(['a']));

    schedulePersistHomeFeed(clientWithLane('user-1', lane(['b'])), 'user-1', environment(storage));
    await clearPersistedHomeFeed(environment(storage));
    await vi.advanceTimersByTimeAsync(PERSIST_HOME_FEED_DEBOUNCE_MS * 2);

    expect(storage.values.has(PERSISTED_HOME_FEED_STORAGE_KEY)).toBe(false);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('lands after a write already under way, so that write cannot undo a sign-out', async () => {
    const storage = memoryStorage();
    let finishWrite = () => undefined as void;
    storage.setItem.mockImplementationOnce((key, value) => new Promise<void>((resolveWrite) => {
      finishWrite = () => {
        storage.values.set(key, value);
        resolveWrite();
      };
    }));

    const write = persistHomeFeed(clientWithLane('user-1', lane(['a'])), 'user-1', environment(storage));
    await vi.waitFor(() => expect(storage.setItem).toHaveBeenCalledOnce());
    const clear = clearPersistedHomeFeed(environment(storage));
    finishWrite();
    await Promise.all([write, clear]);

    expect(storage.values.has(PERSISTED_HOME_FEED_STORAGE_KEY)).toBe(false);
  });
});

describe('isPersistedHomeFeedData', () => {
  it('tells a page carried over from an earlier launch from one fetched in this launch', () => {
    expect(isPersistedHomeFeedData(Date.now() - 60 * 60_000)).toBe(true);
    expect(isPersistedHomeFeedData(Date.now())).toBe(false);
    expect(isPersistedHomeFeedData(0)).toBe(false);
  });
});

describe('wiring', () => {
  const read = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');

  it('restores from the eagerly loaded root layout, as soon as the query client exists', () => {
    const layout = read('app/_layout.tsx');
    const clientAt = layout.indexOf('const queryClient = new QueryClient(');

    expect(clientAt).toBeGreaterThan(-1);
    expect(layout.indexOf('void restorePersistedHomeFeed(queryClient);')).toBeGreaterThan(clientAt);
  });

  it('saves from the lane home starts on, only once auth has settled whose lane it is', () => {
    const dashboard = read('components/home-dashboard.tsx');

    expect(dashboard).toContain("useState<HomeFeedChipId>('for-you')");
    expect(dashboard).toContain(
      'if (isAuthLoading || activeChipId !== PERSISTED_HOME_FEED_CHIP_ID || !feedQuery.isSuccess) return;',
    );
    expect(dashboard).toContain('schedulePersistHomeFeed(queryClient, user?.id);');
    expect(dashboard).toContain('useEffect(() => cancelScheduledPersistHomeFeed, []);');
  });

  it('forgets the saved feed everywhere the signed-in session is cleared from the device', () => {
    const auth = read('lib/auth.tsx');
    const count = (needle: string) => auth.split(needle).length - 1;

    expect(count('clearPersistedSupabaseAuthSession()')).toBeGreaterThan(0);
    expect(count('clearPersistedHomeFeed()')).toBe(count('clearPersistedSupabaseAuthSession()'));
  });
});
