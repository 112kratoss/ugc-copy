import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type PostRow = {
  id: string;
  generation_id: string | null;
  user_id: string;
  visibility: 'public' | 'unlisted' | 'private';
  archived_at: string | null;
  review_status: 'visible' | 'flagged' | 'hidden';
  category: 'image';
  prompt: string | null;
  source_kind: 'magicbooklet';
};

const helperMocks = vi.hoisted(() => ({
  createServiceClient: vi.fn(),
  createUserClient: vi.fn(),
  resolveStoredMediaUrl: vi.fn(),
}));

// The resolver (`getPostReferenceForShowcaseId`) builds its own service client.
// These tests hand it a posts table that applies the filters it asks for, so a
// private, archived or hidden post is turned away by the real query, not a stub.
vi.mock('@/lib/server-helpers', () => helperMocks);

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import { getShowcasePostResolveRouteResponse } from '@/lib/showcase-post-resolve-route-adapter-service';

function createPostsTable(rows: PostRow[], failure: { message: string } | null = null) {
  const reads: string[] = [];

  return {
    reads,
    from(table: string) {
      if (table !== 'posts') {
        throw new Error(`Unexpected table access: ${table}`);
      }
      reads.push(table);

      return {
        select() {
          const filters: Array<{ column: string; value: unknown; operation: 'eq' | 'in' | 'is' }> = [];
          const query = {
            eq(column: string, value: unknown) {
              filters.push({ column, value, operation: 'eq' });
              return query;
            },
            is(column: string, value: unknown) {
              filters.push({ column, value, operation: 'is' });
              return query;
            },
            in(column: string, values: unknown[]) {
              filters.push({ column, value: values, operation: 'in' });
              return query;
            },
            async maybeSingle() {
              if (failure) return { data: null, error: failure };
              const matches = rows.filter((row) => filters.every((filter) => {
                const actual = (row as unknown as Record<string, unknown>)[filter.column] ?? null;
                return filter.operation === 'in'
                  ? (filter.value as unknown[]).includes(actual)
                  : actual === filter.value;
              }));
              return { data: matches[0] ?? null, error: null };
            },
          };
          return query;
        },
      };
    },
  };
}

const livePost: PostRow = {
  id: 'post-1',
  generation_id: 'gen-1',
  user_id: 'creator-1',
  visibility: 'public',
  archived_at: null,
  review_status: 'visible',
  category: 'image',
  prompt: null,
  source_kind: 'magicbooklet',
};

function resolve(
  id: string,
  {
    rows = [livePost],
    failure = null,
    headers = {},
    enforceBackendRateLimit = vi.fn(async () => undefined),
    logError = vi.fn(),
  }: {
    rows?: PostRow[];
    failure?: { message: string } | null;
    headers?: Record<string, string>;
    enforceBackendRateLimit?: ReturnType<typeof vi.fn>;
    logError?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const table = createPostsTable(rows, failure);
  helperMocks.createServiceClient.mockReturnValue(table);

  return {
    table,
    response: getShowcasePostResolveRouteResponse({
      request: new Request(`http://localhost/api/showcase/posts/${id}/resolve`, { headers }),
      context: { params: Promise.resolve({ postId: id }) },
      dependencies: {
        enforceBackendRateLimit: enforceBackendRateLimit as never,
        getFeedNetworkKeyHash: vi.fn(() => 'network-hash-1'),
        logError: logError as never,
      },
    }),
  };
}

describe('showcase post resolve route adapter service', () => {
  beforeEach(() => {
    helperMocks.createServiceClient.mockReset();
    helperMocks.createUserClient.mockReset();
  });

  it('answers a post id with the post itself', async () => {
    const response = await resolve('post-1').response;

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, postId: 'post-1' });
    expect(response.headers.get('Cache-Control')).toBe('public, s-maxage=60, stale-while-revalidate=300');
    expect(response.headers.get('Vary')).toBe('Authorization');
  });

  it('answers an old generation id with the post made from it', async () => {
    const response = await resolve('gen-1').response;

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, postId: 'post-1' });
  });

  it.each([
    ['private', { ...livePost, visibility: 'private' as const }],
    ['archived', { ...livePost, archived_at: '2026-10-01T00:00:00.000Z' }],
    ['hidden', { ...livePost, review_status: 'hidden' as const }],
    ['flagged', { ...livePost, review_status: 'flagged' as const }],
  ])('answers 404 for a %s post, by its id and by its generation id', async (_state, row) => {
    for (const id of ['post-1', 'gen-1']) {
      const response = await resolve(id, { rows: [row] }).response;

      expect(response.status, id).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: 'Post not found.' });
    }
  });

  it('answers 404 for an id nothing has', async () => {
    const response = await resolve('nothing-1').response;

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Post not found.' });
  });

  it('keys the by-id read limit on the viewer when a token is sent, and answers privately', async () => {
    helperMocks.createUserClient.mockReturnValue({
      auth: {
        getUser: vi.fn(async () => ({ data: { user: { id: 'viewer-1' } }, error: null })),
      },
    } as unknown as SupabaseClient);
    const enforceBackendRateLimit = vi.fn(async () => undefined);

    const response = await resolve('gen-1', {
      headers: { Authorization: 'Bearer token-1' },
      enforceBackendRateLimit,
    }).response;

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(enforceBackendRateLimit).toHaveBeenCalledWith(expect.anything(), {
      scope: 'showcase-post:read',
      limit: 300,
      windowSeconds: 600,
      key: 'viewer-1',
    });
  });

  it('keys a caller with no token on the network hash, without asking who it is', async () => {
    const enforceBackendRateLimit = vi.fn(async () => undefined);

    await resolve('post-1', { enforceBackendRateLimit }).response;

    expect(helperMocks.createUserClient).not.toHaveBeenCalled();
    expect(enforceBackendRateLimit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      scope: 'showcase-post:read',
      key: 'network-hash-1',
    }));
  });

  it('answers 429 to a limited caller before any lookup', async () => {
    const { table, response } = resolve('gen-1', {
      enforceBackendRateLimit: vi.fn(async () => {
        throw new BackendRateLimitError({
          allowed: false,
          limit: 300,
          remaining: 0,
          retryAfterSeconds: 12,
          resetAt: '2026-10-17T15:00:00.000Z',
        });
      }),
    });

    const answered = await response;
    expect(answered.status).toBe(429);
    expect(answered.headers.get('Retry-After')).toBe('12');
    await expect(answered.json()).resolves.toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 12 });
    expect(table.reads).toEqual([]);
  });

  it('logs a failed lookup and answers a stable 500', async () => {
    const logError = vi.fn();

    const response = await resolve('post-1', { failure: { message: 'connection reset' }, logError }).response;

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Failed to resolve showcase post.' });
    expect(logError).toHaveBeenCalledWith('Showcase post resolve error:', expect.anything());
  });
});
