import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import { encodePublicSearchCursor } from '@/lib/public-search';
import type { PublicSearchOptions } from '@/lib/public-search-service';
import { getPublicSearchRouteResponse } from '@/lib/public-search-route-adapter-service';
import type { PublicSearchResponse } from '@/lib/public-search';

function emptyResponse(query: string, type: PublicSearchResponse['type']): PublicSearchResponse {
  return {
    query,
    normalizedQuery: query.toLocaleLowerCase(),
    type,
    sort: 'top',
    creators: { items: [], nextCursor: null },
    posts: { items: [], nextCursor: null },
    recipes: { items: [], nextCursor: null },
  };
}

const requestIdBoundary = <T>(_requestId: string, callback: () => T): T => callback();
const allowedRateLimit = () => Promise.resolve({
  allowed: true,
  limit: 180,
  remaining: 179,
  retryAfterSeconds: 0,
  resetAt: '2026-08-27T12:00:00.000Z',
});

describe('public search route adapter service', () => {
  it('serves anonymous search with private caching and a network-scoped rate limit', async () => {
    const searchPublicContent = vi.fn(async () => emptyResponse('Product reveal', 'posts'));
    const enforceBackendRateLimit = vi.fn(allowedRateLimit);
    const createUserClient = vi.fn();

    const response = await getPublicSearchRouteResponse({
      request: new Request('http://localhost/api/search?q=Product%20reveal&type=posts&limit=12', {
        headers: { 'x-request-id': 'search-1', 'x-vercel-ip-country': 'IN' },
      }),
      dependencies: {
        createServiceClient: vi.fn(() => ({}) as SupabaseClient),
        createUserClient,
        enforceBackendRateLimit,
        getFeedNetworkKeyHash: vi.fn(() => 'network-key'),
        searchPublicContent,
        runAfterResponse: () => {},
      withProviderFetchRequestId: requestIdBoundary,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Vary')).toBe('Authorization, x-vercel-ip-country');
    expect(response.headers.get('x-request-id')).toBe('search-1');
    expect(createUserClient).not.toHaveBeenCalled();
    expect(enforceBackendRateLimit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      key: 'network-key',
      scope: 'public-search:read',
    }));
    expect(searchPublicContent).toHaveBeenCalledWith({
      query: 'Product reveal',
      normalizedQuery: 'Product reveal',
      type: 'posts',
      sort: 'top',
      cursor: null,
      limit: 12,
      viewerUserId: null,
      countryCode: 'IN',
    });
  });

  describe('sort', () => {
    const POST_ID = '11111111-1111-4111-8111-111111111111';
    async function ask(url: string) {
      const searchPublicContent = vi.fn(async (options: PublicSearchOptions) => emptyResponse(options.query, options.type));
      const response = await getPublicSearchRouteResponse({
        request: new Request(url),
        dependencies: {
          createServiceClient: vi.fn(() => ({}) as SupabaseClient),
          enforceBackendRateLimit: vi.fn(allowedRateLimit),
          getFeedNetworkKeyHash: vi.fn(() => 'network-key'),
          searchPublicContent,
          runAfterResponse: () => {},
          withProviderFetchRequestId: requestIdBoundary,
        },
      });
      return { response, options: searchPublicContent.mock.calls[0]?.[0] ?? null };
    }

    it('reads Posts and Recipes in the order asked for', async () => {
      expect((await ask('http://localhost/api/search?q=portrait&type=posts&sort=latest')).options?.sort).toBe('latest');
      expect((await ask('http://localhost/api/search?q=portrait&type=recipes&sort=latest')).options?.sort).toBe('latest');
      expect((await ask('http://localhost/api/search?q=portrait&type=posts&sort=top')).options?.sort).toBe('top');
      expect((await ask('http://localhost/api/search?q=portrait&type=posts')).options?.sort).toBe('top');
    });

    it('accepts a sort on Top and Creators and reads them ranked: they have one order', async () => {
      const top = await ask('http://localhost/api/search?q=portrait&sort=latest');
      const creators = await ask('http://localhost/api/search?q=portrait&type=creators&sort=latest');
      expect(top.response.status).toBe(200);
      expect(top.options?.sort).toBe('top');
      expect(creators.response.status).toBe(200);
      expect(creators.options?.sort).toBe('top');
    });

    it.each([
      'http://localhost/api/search?q=portrait&type=posts&sort=oldest',
      'http://localhost/api/search?q=portrait&type=posts&sort=',
      'http://localhost/api/search?q=portrait&sort=LATEST',
      'http://localhost/api/search?q=portrait&type=creators&sort=newest',
    ])('refuses an unknown sort, whatever the type: %s', async (url) => {
      const { response, options } = await ask(url);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'sort must be top or latest.' });
      expect(options).toBeNull();
    });

    it('pages a cursor only in the order it was issued for', async () => {
      const topCursor = encodePublicSearchCursor({
        version: 1, type: 'posts', score: 12.5, id: POST_ID, asOf: Date.parse('2026-11-12T10:00:00.000Z'),
      });
      const latestCursor = encodePublicSearchCursor({
        version: 1, type: 'posts', sort: 'latest', createdAt: '2026-11-12T10:00:00.123456+00:00', id: POST_ID,
      });
      const base = 'http://localhost/api/search?q=portrait&type=posts';

      const top = await ask(`${base}&cursor=${topCursor}`);
      expect(top.options?.cursor).toEqual({
        version: 1, type: 'posts', score: 12.5, id: POST_ID, asOf: Date.parse('2026-11-12T10:00:00.000Z'),
      });
      const latest = await ask(`${base}&sort=latest&cursor=${latestCursor}`);
      expect(latest.options?.cursor).toEqual({
        version: 1, type: 'posts', sort: 'latest', createdAt: '2026-11-12T10:00:00.123456+00:00', id: POST_ID,
      });

      for (const url of [`${base}&sort=latest&cursor=${topCursor}`, `${base}&cursor=${latestCursor}`]) {
        const crossed = await ask(url);
        expect(crossed.response.status).toBe(400);
        await expect(crossed.response.json()).resolves.toEqual({
          error: 'cursor is invalid for this search type and sort.',
        });
        expect(crossed.options).toBeNull();
      }
    });

    it('still pages a cursor issued before sorts and instants existed', async () => {
      // What the app live before 2026-11-12 handed out: a score and an id.
      const legacy = Buffer.from(JSON.stringify({ v: 1, t: 'posts', s: 8.25, i: POST_ID }), 'utf8').toString('base64url');
      const { response, options } = await ask(`http://localhost/api/search?q=portrait&type=posts&cursor=${legacy}`);
      expect(response.status).toBe(200);
      expect(options?.sort).toBe('top');
      expect(options?.cursor).toEqual({ version: 1, type: 'posts', score: 8.25, id: POST_ID });
    });
  });

  it('refuses a query the database would count as too short, an emoji being one character', async () => {
    // search_public_creators and search_public_posts raise below two and three
    // characters by char_length: a query let through on `.length` was a 500.
    const searchPublicContent = vi.fn(async () => emptyResponse('', 'top'));
    const ask = (search: string) => getPublicSearchRouteResponse({
      request: new Request(`http://localhost/api/search?${search}`),
      dependencies: {
        createServiceClient: vi.fn(() => ({}) as SupabaseClient),
        createUserClient: vi.fn(),
        enforceBackendRateLimit: vi.fn(allowedRateLimit),
        getFeedNetworkKeyHash: vi.fn(() => 'network-key'),
        searchPublicContent,
        runAfterResponse: () => {},
      withProviderFetchRequestId: requestIdBoundary,
      },
    });
    const emoji = encodeURIComponent('\u{1F600}');

    expect((await ask(`q=${emoji}`)).status).toBe(400);
    expect((await ask(`q=${emoji}${emoji}&type=posts`)).status).toBe(400);
    expect((await ask(`q=${emoji}${emoji}&type=recipes`)).status).toBe(400);
    expect(searchPublicContent).not.toHaveBeenCalled();

    expect((await ask(`q=${emoji}${emoji}&type=creators`)).status).toBe(200);
    expect((await ask(`q=${emoji}${emoji}${emoji}&type=posts`)).status).toBe(200);
    expect(searchPublicContent).toHaveBeenCalledTimes(2);
  });

  it('uses verified optional auth for personalized filtering', async () => {
    const searchPublicContent = vi.fn(async () => emptyResponse('@luna', 'creators'));
    const response = await getPublicSearchRouteResponse({
      request: new Request('http://localhost/api/search?q=%40luna&type=creators', {
        headers: { Authorization: 'Bearer token' },
      }),
      dependencies: {
        createServiceClient: vi.fn(() => ({}) as SupabaseClient),
        createUserClient: vi.fn(() => ({
          auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'viewer-1' } }, error: null })) },
        }) as unknown as SupabaseClient),
        enforceBackendRateLimit: vi.fn(allowedRateLimit),
        getFeedNetworkKeyHash: vi.fn(() => 'network-key'),
        searchPublicContent,
        runAfterResponse: () => {},
      withProviderFetchRequestId: requestIdBoundary,
      },
    });

    expect(response.status).toBe(200);
    expect(searchPublicContent).toHaveBeenCalledWith(expect.objectContaining({
      query: '@luna',
      normalizedQuery: 'luna',
      viewerUserId: 'viewer-1',
    }));
  });

  it.each([
    ['http://localhost/api/search?q=a', 'q must contain at least 2 characters.'],
    ['http://localhost/api/search?q=ab&type=posts', 'posts search requires at least 3 characters.'],
    ['http://localhost/api/search?q=photo&type=unknown', 'type must be top, creators, posts, or recipes.'],
    ['http://localhost/api/search?q=photo&limit=200', 'limit must be an integer between 1 and 24.'],
  ])('rejects invalid requests before searching: %s', async (url, message) => {
    const searchPublicContent = vi.fn();
    const response = await getPublicSearchRouteResponse({
      request: new Request(url),
      dependencies: {
        searchPublicContent,
        runAfterResponse: () => {},
      withProviderFetchRequestId: requestIdBoundary,
      },
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: message });
    expect(searchPublicContent).not.toHaveBeenCalled();
  });

  it('keeps rate-limit responses private and retryable', async () => {
    const response = await getPublicSearchRouteResponse({
      request: new Request('http://localhost/api/search?q=portrait'),
      dependencies: {
        createServiceClient: vi.fn(() => ({}) as SupabaseClient),
        enforceBackendRateLimit: vi.fn(async () => {
          throw new BackendRateLimitError({
            allowed: false,
            limit: 180,
            remaining: 0,
            retryAfterSeconds: 9,
            resetAt: '2026-08-27T12:00:00.000Z',
          });
        }),
        getFeedNetworkKeyHash: vi.fn(() => 'network-key'),
        runAfterResponse: () => {},
      withProviderFetchRequestId: requestIdBoundary,
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('9');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });

  describe('the anonymous search log', () => {
    function logHarness(options: { insert?: () => Promise<{ error: unknown }> } = {}) {
      const insert = vi.fn(options.insert ?? (async () => ({ error: null })));
      const from = vi.fn(() => ({ insert }));
      const rpc = vi.fn(async () => ({ data: 'e'.repeat(64), error: null }));
      const tasks: Array<() => Promise<unknown>> = [];
      const logEvent = vi.fn();
      const ask = (url: string, extra: Record<string, unknown> = {}) => getPublicSearchRouteResponse({
        request: new Request(url, { headers: (extra.headers as Record<string, string>) ?? {} }),
        dependencies: {
          createServiceClient: vi.fn(() => ({ from, rpc }) as unknown as SupabaseClient),
          createUserClient: vi.fn(() => ({
            auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'viewer-1' } }, error: null })) },
          }) as unknown as SupabaseClient),
          enforceBackendRateLimit: vi.fn(allowedRateLimit),
          getFeedNetworkKeyHash: vi.fn(() => 'network-key'),
          searchPublicContent: vi.fn(async () => emptyResponse('Port', 'top')),
          logEvent,
          runAfterResponse: (task) => { tasks.push(task); },
          withProviderFetchRequestId: requestIdBoundary,
          ...extra,
        },
      });
      return { ask, insert, from, rpc, tasks, logEvent };
    }

    it('returns the answer without awaiting the write', async () => {
      const { ask, insert, tasks } = logHarness({ insert: () => new Promise(() => {}) });
      const response = await ask('http://localhost/api/search?q=Port');
      expect(response.status).toBe(200);
      expect(tasks).toHaveLength(1);
      expect(insert).not.toHaveBeenCalled();
      // The write never settles; the answer already has.
      void tasks[0]();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(insert).toHaveBeenCalledTimes(1);
    });

    it('logs one anonymous row for a first page: the query lowercased, never the key', async () => {
      const { ask, insert, from, tasks } = logHarness();
      await ask('http://localhost/api/search?q=Port&type=top');
      await tasks[0]();
      expect(from).toHaveBeenCalledWith('search_query_events');
      const [row] = insert.mock.calls[0] as unknown as [Record<string, unknown>];
      expect(row).toMatchObject({
        query: 'port', search_type: 'top', signed_in: false, creator_count: 0, post_count: 0, recipe_count: 0,
        sort: null,
      });
      expect(Object.keys(row).sort()).toEqual([
        'created_at', 'creator_count', 'post_count', 'query', 'recipe_count', 'search_type', 'signed_in', 'sort',
        'visitor_day',
      ]);
      expect(JSON.stringify(row)).not.toContain('network-key');
    });

    it('logs the order a Posts search asked for', async () => {
      const { ask, insert, tasks } = logHarness();
      await ask('http://localhost/api/search?q=Port&type=posts&sort=latest', {
        searchPublicContent: vi.fn(async () => emptyResponse('Port', 'posts')),
      });
      await tasks[0]();
      const [row] = insert.mock.calls[0] as unknown as [Record<string, unknown>];
      expect(row).toMatchObject({ search_type: 'posts', sort: 'latest' });
    });

    it('marks a signed-in search and keys it on the user without storing the id', async () => {
      const { ask, insert, tasks } = logHarness();
      await ask('http://localhost/api/search?q=Port', { headers: { Authorization: 'Bearer token' } });
      await tasks[0]();
      const [row] = insert.mock.calls[0] as unknown as [Record<string, unknown>];
      expect(row.signed_in).toBe(true);
      expect(JSON.stringify(row)).not.toContain('viewer-1');
    });

    it('stamps the row with the time the request arrived, not the time the write runs', async () => {
      const { ask, insert, tasks } = logHarness();
      const before = Date.now();
      await ask('http://localhost/api/search?q=Port');
      const after = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await tasks[0]();
      const [row] = insert.mock.calls[0] as unknown as [{ created_at: string }];
      const stamped = Date.parse(row.created_at);
      expect(stamped).toBeGreaterThanOrEqual(before);
      expect(stamped).toBeLessThanOrEqual(after);
    });

    it('does not call a guest session signed in', async () => {
      const { ask, insert, tasks } = logHarness();
      await ask('http://localhost/api/search?q=Port', {
        headers: { Authorization: 'Bearer guest' },
        createUserClient: vi.fn(() => ({
          auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'guest-1', is_anonymous: true } }, error: null })) },
        }) as unknown as SupabaseClient),
      });
      await tasks[0]();
      const [row] = insert.mock.calls[0] as unknown as [Record<string, unknown>];
      expect(row.signed_in).toBe(false);
      expect(JSON.stringify(row)).not.toContain('guest-1');
    });

    it('writes nothing for a request with a cursor', async () => {
      const { ask, tasks } = logHarness();
      const cursor = encodePublicSearchCursor({ version: 1, type: 'recipes', offset: 12 });
      const response = await ask(`http://localhost/api/search?q=portrait&type=recipes&cursor=${cursor}`);
      expect(response.status).toBe(200);
      expect(tasks).toHaveLength(0);
    });

    it.each([
      ['a 400', 'http://localhost/api/search?q=a', {}],
      ['a 401', 'http://localhost/api/search?q=Port', {
        headers: { Authorization: 'Bearer bad' },
        createUserClient: vi.fn(() => ({
          auth: { getUser: vi.fn(async () => ({ data: { user: null }, error: { message: 'bad' } })) },
        }) as unknown as SupabaseClient),
      }],
      ['a 429', 'http://localhost/api/search?q=Port', {
        enforceBackendRateLimit: vi.fn(async () => {
          throw new BackendRateLimitError({
            allowed: false, limit: 180, remaining: 0, retryAfterSeconds: 9, resetAt: '2026-08-27T12:00:00.000Z',
          });
        }),
      }],
      ['a 500', 'http://localhost/api/search?q=Port', {
        searchPublicContent: vi.fn(async () => { throw new Error('search failed'); }),
        logError: vi.fn(),
      }],
    ])('writes nothing for %s', async (_label, url, extra) => {
      const { ask, tasks } = logHarness();
      const response = await ask(url, extra);
      expect(response.status).not.toBe(200);
      expect(tasks).toHaveLength(0);
    });

    it('answers 200 even when the insert fails, the scheduler throws, or the switch is off', async () => {
      const failing = logHarness({ insert: async () => ({ error: { message: 'boom' } }) });
      expect((await failing.ask('http://localhost/api/search?q=Port')).status).toBe(200);
      await failing.tasks[0]();
      expect(failing.logEvent).toHaveBeenCalledWith('warn', 'search_query_log_failed', expect.anything());

      const noScheduler = logHarness();
      const response = await noScheduler.ask('http://localhost/api/search?q=Port', {
        runAfterResponse: () => { throw new Error('outside a request'); },
      });
      expect(response.status).toBe(200);

      vi.stubEnv('SEARCH_QUERY_LOG_DISABLED', '1');
      try {
        const off = logHarness();
        expect((await off.ask('http://localhost/api/search?q=Port')).status).toBe(200);
        expect(off.tasks).toHaveLength(0);
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });
});
