import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  SHOWCASE_FEED_NEWEST_CACHE_CONTROL,
  getNewestShowcaseFeedPost,
  getShowcaseFeedNewestRouteResponse,
  normalizeShowcaseFeedNewestCategory,
  type ShowcaseFeedNewestCategory,
} from '@/lib/showcase-feed-newest-route-adapter-service';

// What a feed read would call to rank a lane, open a session and record its
// deliveries. The probe must reach none of it.
const feedReads = vi.hoisted(() => ({
  getShowcaseFeedPage: vi.fn(),
  getPersonalizedShowcaseFeedPage: vi.fn(),
}));

vi.mock('@/lib/showcase-feed', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/showcase-feed')>()),
  getShowcaseFeedPage: feedReads.getShowcaseFeedPage,
}));

vi.mock('@/lib/showcase-feed-personalization', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/showcase-feed-personalization')>()),
  getPersonalizedShowcaseFeedPage: feedReads.getPersonalizedShowcaseFeedPage,
}));

type Post = {
  id: string;
  created_at: string;
  visibility: 'public' | 'unlisted' | 'private';
  archived_at: string | null;
  review_status: 'visible' | 'flagged' | 'hidden';
  is_nsfw: boolean;
  post_format: 'text' | 'media' | 'mixed';
  category: string;
};

function post(id: string, createdAt: string, overrides: Partial<Post> = {}): Post {
  return {
    id,
    created_at: createdAt,
    visibility: 'public',
    archived_at: null,
    review_status: 'visible',
    is_nsfw: false,
    post_format: 'media',
    category: 'image',
    ...overrides,
  };
}

/**
 * `posts` in memory behind the builder calls the probe makes, applied as
 * PostgREST would apply them, with every call kept in order. Any other table,
 * or any RPC but the rate limiter's, fails the test: the probe opens no feed
 * session and records no delivery.
 */
function createDatabase(posts: Post[], { queryError = null }: { queryError?: { message: string } | null } = {}) {
  const calls: unknown[][] = [];
  const from = vi.fn((table: string) => {
    if (table !== 'posts') throw new Error(`The newest probe read ${table}.`);
    let rows = [...posts];
    const orders: Array<{ column: keyof Post; ascending: boolean }> = [];
    let rowLimit = Number.POSITIVE_INFINITY;
    const query = {
      select: (columns: string) => {
        calls.push(['select', columns]);
        return query;
      },
      eq: (column: keyof Post, value: unknown) => {
        calls.push(['eq', column, value]);
        rows = rows.filter((row) => row[column] === value);
        return query;
      },
      is: (column: keyof Post, value: null) => {
        calls.push(['is', column, value]);
        rows = rows.filter((row) => row[column] === value);
        return query;
      },
      neq: (column: keyof Post, value: unknown) => {
        calls.push(['neq', column, value]);
        rows = rows.filter((row) => row[column] !== value);
        return query;
      },
      or: (filters: string) => {
        calls.push(['or', filters]);
        const alternatives = filters.split(',').map((filter) => {
          const [column, operator, value] = filter.split('.');
          if (operator !== 'eq') throw new Error(`Unsupported filter ${filter}`);
          return (row: Post) => String(row[column as keyof Post]) === value;
        });
        rows = rows.filter((row) => alternatives.some((matches) => matches(row)));
        return query;
      },
      order: (column: keyof Post, { ascending }: { ascending: boolean }) => {
        calls.push(['order', column, { ascending }]);
        orders.push({ column, ascending });
        return query;
      },
      limit: (count: number) => {
        calls.push(['limit', count]);
        rowLimit = count;
        return query;
      },
      maybeSingle: async () => {
        calls.push(['maybeSingle']);
        if (queryError) return { data: null, error: queryError };
        const page = [...rows].sort((left, right) => {
          for (const { column, ascending } of orders) {
            const order = String(left[column]).localeCompare(String(right[column]));
            if (order !== 0) return ascending ? order : -order;
          }
          return 0;
        }).slice(0, rowLimit);
        if (page.length > 1) return { data: null, error: { message: 'JSON object requested, multiple rows returned' } };
        return { data: page[0] ? { id: page[0].id, created_at: page[0].created_at } : null, error: null };
      },
    };
    return query;
  });
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name !== 'check_backend_rate_limit') throw new Error(`The newest probe called ${name}.`);
    return {
      data: {
        allowed: true,
        limit: args.p_limit,
        remaining: Number(args.p_limit) - 1,
        retryAfterSeconds: 0,
        resetAt: '2026-10-14T06:10:00.000Z',
      },
      error: null,
    };
  });
  return { client: { from, rpc } as unknown as SupabaseClient, from, rpc, calls };
}

async function probe(
  database: ReturnType<typeof createDatabase>,
  query = '',
  headers: Record<string, string> = { 'x-request-id': 'newest-probe-1' },
) {
  return getShowcaseFeedNewestRouteResponse({
    request: new Request(`http://localhost/api/showcase/feed/newest${query}`, { headers }),
    dependencies: {
      createServiceClient: vi.fn(() => database.client),
      getFeedNetworkKeyHash: vi.fn(() => 'network-hash'),
      logError: vi.fn(),
    },
  });
}

// Newer than every post a lane may show, and each left out for its own reason.
const UNSHOWABLE = [
  post('nsfw', '2026-10-14T05:59:00.000Z', { is_nsfw: true }),
  post('flagged', '2026-10-14T05:58:00.000Z', { review_status: 'flagged' }),
  post('hidden', '2026-10-14T05:57:30.000Z', { review_status: 'hidden' }),
  post('unlisted', '2026-10-14T05:57:00.000Z', { visibility: 'unlisted' }),
  post('private', '2026-10-14T05:56:30.000Z', { visibility: 'private' }),
  post('archived', '2026-10-14T05:56:00.000Z', { archived_at: '2026-10-14T05:56:10.000Z' }),
  post('nsfw-note', '2026-10-14T05:55:30.000Z', { post_format: 'text', category: 'text', is_nsfw: true }),
];

describe('showcase feed newest-post probe', () => {
  it('names the newest post a reader can see in each lane', async () => {
    const newestIsANote = createDatabase([
      ...UNSHOWABLE,
      post('note', '2026-10-14T05:50:00.000Z', { post_format: 'text', category: 'text' }),
      post('clip', '2026-10-14T05:40:00.000Z', { category: 'video' }),
      post('older-note', '2026-10-14T05:30:00.000Z', { post_format: 'text', category: 'text' }),
    ]);
    const newestIsMedia = createDatabase([
      ...UNSHOWABLE,
      post('picture', '2026-10-14T05:50:00.000Z'),
      post('captioned', '2026-10-14T05:45:00.000Z', { post_format: 'mixed', category: 'image' }),
    ]);
    const newest = async (database: ReturnType<typeof createDatabase>, category: ShowcaseFeedNewestCategory) => (
      getNewestShowcaseFeedPost({ category, serviceClient: database.client })
    );

    await expect(newest(newestIsANote, 'all')).resolves.toEqual({
      newestPostId: 'note',
      newestPublishedAt: '2026-10-14T05:50:00.000Z',
    });
    await expect(newest(newestIsANote, 'media')).resolves.toMatchObject({ newestPostId: 'clip' });
    await expect(newest(newestIsANote, 'text')).resolves.toMatchObject({ newestPostId: 'note' });
    await expect(newest(newestIsMedia, 'all')).resolves.toMatchObject({ newestPostId: 'picture' });
    await expect(newest(newestIsMedia, 'media')).resolves.toMatchObject({ newestPostId: 'picture' });
    // A mixed post is in the text lane as the feed's text filter has it.
    await expect(newest(newestIsMedia, 'text')).resolves.toMatchObject({ newestPostId: 'captioned' });
  });

  it("reads one row with the feed's predicates, in its recent order", async () => {
    const database = createDatabase([post('picture', '2026-10-14T05:50:00.000Z')]);

    await getNewestShowcaseFeedPost({ category: 'media', serviceClient: database.client });

    expect(database.from).toHaveBeenCalledTimes(1);
    expect(database.calls).toEqual([
      ['select', 'id, created_at'],
      ['eq', 'visibility', 'public'],
      ['is', 'archived_at', null],
      ['eq', 'review_status', 'visible'],
      ['eq', 'is_nsfw', false],
      ['neq', 'post_format', 'text'],
      ['order', 'created_at', { ascending: false }],
      ['order', 'id', { ascending: false }],
      ['limit', 1],
      ['maybeSingle'],
    ]);
  });

  it('answers nulls for a lane with no post', async () => {
    const response = await probe(createDatabase(UNSHOWABLE), '?category=text');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ newestPostId: null, newestPublishedAt: null });
  });

  it.each([
    [null, 'all'],
    ['', 'all'],
    ['all', 'all'],
    ['media', 'media'],
    ['text', 'text'],
    ['image', 'media'],
    ['video', 'media'],
    ['motion', 'media'],
    ['anything-else', 'all'],
  ] as const)('reads category %j as the %s lane', (value, lane) => {
    expect(normalizeShowcaseFeedNewestCategory(value)).toBe(lane);
  });

  it('honours the category a lane sends, and defaults to all', async () => {
    const database = createDatabase([
      post('note', '2026-10-14T05:50:00.000Z', { post_format: 'text', category: 'text' }),
      post('clip', '2026-10-14T05:40:00.000Z', { category: 'video' }),
    ]);

    await expect((await probe(database)).json()).resolves.toMatchObject({ newestPostId: 'note' });
    await expect((await probe(database, '?category=media')).json()).resolves.toMatchObject({ newestPostId: 'clip' });
    await expect((await probe(database, '?category=video')).json()).resolves.toMatchObject({ newestPostId: 'clip' });
    await expect((await probe(database, '?category=text')).json()).resolves.toMatchObject({ newestPostId: 'note' });
  });

  it('serves one public answer for thirty seconds, whoever asks', async () => {
    const database = createDatabase([post('picture', '2026-10-14T05:50:00.123456+00:00')]);

    const response = await probe(database, '?category=media', {
      'x-request-id': 'newest-probe-1',
      Authorization: 'Bearer any-viewer-token',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=30');
    expect(SHOWCASE_FEED_NEWEST_CACHE_CONTROL).toBe('public, max-age=30');
    expect(response.headers.get('x-request-id')).toBe('newest-probe-1');
    expect(response.headers.get('set-cookie')).toBeNull();
    await expect(response.json()).resolves.toEqual({
      newestPostId: 'picture',
      newestPublishedAt: '2026-10-14T05:50:00.123Z',
    });
  });

  it('is charged to the general feed-read budget by network, and mints nothing', async () => {
    const database = createDatabase([post('picture', '2026-10-14T05:50:00.000Z')]);

    const response = await probe(database, '?category=media', { Authorization: 'Bearer viewer-token' });

    expect(response.status).toBe(200);
    expect(database.rpc).toHaveBeenCalledTimes(1);
    expect(database.rpc).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'showcase-feed:read',
      p_subject_key: 'network-hash',
      p_limit: 240,
      p_window_seconds: 600,
    });
    // Only `posts` was read: no feed session, no delivery, no ranked page.
    expect(database.from.mock.calls).toEqual([['posts']]);
    expect(feedReads.getShowcaseFeedPage).not.toHaveBeenCalled();
    expect(feedReads.getPersonalizedShowcaseFeedPage).not.toHaveBeenCalled();
  });

  it('answers 429 uncached once the budget is spent, without reading posts', async () => {
    const database = createDatabase([post('picture', '2026-10-14T05:50:00.000Z')]);
    database.rpc.mockResolvedValueOnce({
      data: { allowed: false, limit: 240, remaining: 0, retryAfterSeconds: 30, resetAt: '2026-10-14T06:10:00.000Z' },
      error: null,
    });

    const response = await probe(database, '?category=media');

    expect(response.status).toBe(429);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(database.from).not.toHaveBeenCalled();
  });

  it('answers 500 uncached when the read fails', async () => {
    const response = await probe(
      createDatabase([], { queryError: { message: 'statement timeout' } }),
      '?category=media',
    );

    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({ error: 'Failed to check for newer posts.' });
  });
});
