import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getFeedChip } from '@/lib/post-feed-chips';
import { SHOWCASE_FEED_CACHE_TAG } from '@/lib/showcase-feed-cache';

type CacheOptions = { revalidate?: number | false; tags?: string[] };

/** `kept` stands for what Next hands back instead of running the read: an entry it already holds. */
type CachedRead = { keyParts: string[]; options: CacheOptions; calls: number; failure: Error | null; kept?: unknown };

const cachedReads = vi.hoisted(() => [] as CachedRead[]);
const readHomeFeedMock = vi.hoisted(() => vi.fn());
const loadHomeShelfForApiMock = vi.hoisted(() => vi.fn());
const logBackendErrorMock = vi.hoisted(() => vi.fn());
const logBackendWarningMock = vi.hoisted(() => vi.fn());

vi.mock('next/cache', () => ({
  revalidateTag: vi.fn(),
  unstable_cache: (read: (...args: unknown[]) => Promise<unknown>, keyParts: string[], options: CacheOptions) => {
    const entry: CachedRead = { keyParts, options, calls: 0, failure: null };
    cachedReads.push(entry);
    return (...args: unknown[]) => {
      entry.calls += 1;
      if (entry.failure) return Promise.reject(entry.failure);
      return 'kept' in entry ? Promise.resolve(entry.kept) : read(...args);
    };
  },
}));

vi.mock('@/lib/home-dashboard-service', () => ({
  readHomeFeed: (request: unknown) => readHomeFeedMock(request),
}));

vi.mock('@/lib/home-shelf-server', () => ({
  loadHomeShelfForApi: (identity: unknown) => loadHomeShelfForApiMock(identity),
  withoutPost: ({ post, ...creation }: Record<string, unknown>) => {
    void post;
    return creation;
  },
}));

vi.mock('@/lib/backend-logger', () => ({
  logBackendError: (event: string, fields: unknown) => logBackendErrorMock(event, fields),
  logBackendWarning: (event: string, fields: unknown) => logBackendWarningMock(event, fields),
}));

const RELEASE_VARIABLES = ['RELEASE_GIT_SHA', 'VERCEL_GIT_COMMIT_SHA', 'VERCEL_DEPLOYMENT_ID', 'VERCEL_URL'];

async function loadModule(environment: Record<string, string> = {}) {
  for (const name of RELEASE_VARIABLES) vi.stubEnv(name, environment[name] ?? '');
  vi.resetModules();
  cachedReads.length = 0;
  return import('@/lib/anonymous-home-data');
}

function cachedRead(name: string) {
  const entry = cachedReads.find((candidate) => candidate.keyParts[0] === name);
  if (!entry) throw new Error(`no cached read named ${name}`);
  return entry;
}

const FEED = {
  items: [],
  availableTools: [],
  pageInfo: { hasMore: false, nextOffset: null, limit: 12, offset: 0 },
};

describe('the signed-out home reads', () => {
  beforeEach(() => {
    readHomeFeedMock.mockReset();
    readHomeFeedMock.mockResolvedValue(FEED);
    loadHomeShelfForApiMock.mockReset();
    loadHomeShelfForApiMock.mockResolvedValue([]);
    logBackendErrorMock.mockReset();
    logBackendWarningMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('caches the feed and the shelf for the 15 minutes the page keeps, under the feed tag', async () => {
    const { ANONYMOUS_HOME_REVALIDATE_SECONDS } = await loadModule();

    expect(ANONYMOUS_HOME_REVALIDATE_SECONDS).toBe(900);
    for (const name of ['anonymous-home-feed-v2', 'anonymous-home-shelf-v2']) {
      expect(cachedRead(name).options).toEqual({ revalidate: 900, tags: [SHOWCASE_FEED_CACHE_TAG] });
    }
  });

  it("keys every cached read by the deployment, so a deploy never draws the page from another's data", async () => {
    // A configuration-only redeploy keeps the commit, so the deployment comes first.
    await loadModule({ VERCEL_DEPLOYMENT_ID: 'dpl_2', RELEASE_GIT_SHA: 'sha-new', VERCEL_GIT_COMMIT_SHA: 'sha-git' });
    expect(cachedRead('anonymous-home-feed-v2').keyParts).toEqual(['anonymous-home-feed-v2', 'dpl_2']);
    expect(cachedRead('anonymous-home-shelf-v2').keyParts).toEqual(['anonymous-home-shelf-v2', 'dpl_2']);

    // Off Vercel, the release, as the root layout's data-build-id reads it.
    await loadModule({ RELEASE_GIT_SHA: 'sha-new', VERCEL_GIT_COMMIT_SHA: 'sha-git' });
    expect(cachedRead('anonymous-home-feed-v2').keyParts).toEqual(['anonymous-home-feed-v2', 'sha-new']);
    await loadModule({ VERCEL_GIT_COMMIT_SHA: 'sha-git' });
    expect(cachedRead('anonymous-home-feed-v2').keyParts).toEqual(['anonymous-home-feed-v2', 'sha-git']);
    await loadModule();
    expect(cachedRead('anonymous-home-feed-v2').keyParts).toEqual(['anonymous-home-feed-v2', 'dev']);
  });

  it('reads the For you lane as a signed-out visitor sees it', async () => {
    const { loadAnonymousHomeFeed } = await loadModule();

    await expect(loadAnonymousHomeFeed()).resolves.toBe(FEED);

    expect(readHomeFeedMock).toHaveBeenCalledWith({ viewerUserId: null, chip: getFeedChip(undefined) });
    expect(cachedRead('anonymous-home-retry-window-v1').calls).toBe(0);
  });

  it('keeps no failed feed read and asks for a rebuild within a minute', async () => {
    const failure = new Error('feed offline');
    readHomeFeedMock.mockRejectedValue(failure);
    const { ANONYMOUS_HOME_RETRY_SECONDS, loadAnonymousHomeFeed } = await loadModule();

    await expect(loadAnonymousHomeFeed()).resolves.toBeNull();

    expect(logBackendErrorMock).toHaveBeenCalledWith('home_dashboard_feed_load_failed', { error: failure });
    expect(ANONYMOUS_HOME_RETRY_SECONDS).toBe(60);
    const marker = cachedRead('anonymous-home-retry-window-v1');
    expect(marker.options).toEqual({ revalidate: 60 });
    expect(marker.calls).toBe(1);
  });

  it('reads the shelf as a signed-out visitor, with no full post in it', async () => {
    const action = { kind: 'action', id: 'invite' };
    loadHomeShelfForApiMock.mockResolvedValue([
      { kind: 'creation', id: 'boat', title: 'Boat', post: { id: 'boat', body: 'the whole post' } },
      action,
    ]);
    const { loadAnonymousHomeShelf } = await loadModule();

    await expect(loadAnonymousHomeShelf()).resolves.toEqual([
      { kind: 'creation', id: 'boat', title: 'Boat' },
      action,
    ]);

    expect(loadHomeShelfForApiMock).toHaveBeenCalledWith({ viewerUserId: null, isAnonymous: false });
    expect(cachedRead('anonymous-home-retry-window-v1').calls).toBe(0);
  });

  it('keeps no failed shelf read and asks for a rebuild within a minute', async () => {
    const failure = new Error('shelf offline');
    loadHomeShelfForApiMock.mockRejectedValue(failure);
    const { loadAnonymousHomeShelf } = await loadModule();

    await expect(loadAnonymousHomeShelf()).resolves.toEqual([]);

    expect(logBackendErrorMock).toHaveBeenCalledWith('anonymous_home_shelf_load_failed', { error: failure });
    expect(cachedRead('anonymous-home-retry-window-v1').calls).toBe(1);
  });

  // When the refresh of an expired entry throws, Next logs it and hands back the
  // entry it held: the failure arrives as data older than the window.
  it.each([
    ['feed', 'anonymous-home-feed-v2', 'home_feed_kept_past_window', FEED],
    ['shelf', 'anonymous-home-shelf-v2', 'home_shelf_kept_past_window', [{ kind: 'creation', id: 'boat' }]],
  ] as const)('keeps a %s handed back past its window, and asks for a rebuild within a minute', async (
    _section,
    key,
    event,
    value,
  ) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-04T12:00:00.000Z'));
    try {
      const reads = await loadModule();
      const builtAt = Date.parse('2026-11-04T11:44:59.000Z');
      cachedRead(key).kept = { builtAt, value };

      const shown = key.includes('feed') ? await reads.loadAnonymousHomeFeed() : await reads.loadAnonymousHomeShelf();

      expect(shown).toEqual(value);
      expect(cachedRead('anonymous-home-retry-window-v1').calls).toBe(1);
      // A warning of its own: a stale-session render is served an aged entry as a
      // matter of course, and the error events stay for reads that threw.
      expect(logBackendErrorMock).not.toHaveBeenCalled();
      expect(logBackendWarningMock).toHaveBeenCalledWith(event, {
        builtAt: '2026-11-04T11:44:59.000Z',
        ageSeconds: 901,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks nothing of an entry still inside its window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-04T12:00:00.000Z'));
    try {
      const { loadAnonymousHomeFeed, loadAnonymousHomeShelf } = await loadModule();
      const builtAt = Date.parse('2026-11-04T11:45:01.000Z');
      cachedRead('anonymous-home-feed-v2').kept = { builtAt, value: FEED };
      cachedRead('anonymous-home-shelf-v2').kept = { builtAt, value: [] };

      await expect(loadAnonymousHomeFeed()).resolves.toBe(FEED);
      await expect(loadAnonymousHomeShelf()).resolves.toEqual([]);

      expect(cachedRead('anonymous-home-retry-window-v1').calls).toBe(0);
      expect(logBackendErrorMock).not.toHaveBeenCalled();
      expect(logBackendWarningMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still answers when the retry marker cannot be read outside a render', async () => {
    readHomeFeedMock.mockRejectedValue(new Error('feed offline'));
    loadHomeShelfForApiMock.mockRejectedValue(new Error('shelf offline'));
    const { loadAnonymousHomeFeed, loadAnonymousHomeShelf } = await loadModule();
    // Outside a request there is no incremental cache, and Next's read throws.
    cachedRead('anonymous-home-retry-window-v1').failure = new Error(
      'Invariant: incrementalCache missing in unstable_cache',
    );

    await expect(loadAnonymousHomeFeed()).resolves.toBeNull();
    await expect(loadAnonymousHomeShelf()).resolves.toEqual([]);
  });
});
