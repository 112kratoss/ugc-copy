import { AuthApiError, type SupabaseClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

import { BackendRateLimitError, type enforceBackendRateLimit } from '@/lib/backend-rate-limit';
import { guardUserFacingRouteIdentity } from '@/lib/route-identity-admission';
import { routeIdentityPolicy } from '@/lib/route-identity-policy';
import {
  SHOWCASE_FEED_FEEDBACK_UNDO_REQUEST_BODY_MAX_BYTES,
  postShowcaseFeedFeedbackUndoRouteResponse,
} from '@/lib/showcase-feed-feedback-undo-route-adapter-service';

const UNDO_PATH = '/api/showcase/feed/feedback/undo';
const POST_A = '7a000000-0000-4000-8000-00000000000a';
const POST_B = '7a000000-0000-4000-8000-00000000000b';
const CREATOR_A = '7c000000-0000-4000-8000-00000000000a';
const CREATOR_B = '7c000000-0000-4000-8000-00000000000b';

type Row = Record<string, unknown>;

/**
 * The two feedback tables and `profiles` in memory, behind the part of the
 * supabase-js builder this route uses: `delete` narrowed by `eq` / `is`, then
 * `select` for the rows it removed, and the lifecycle read `requireIdentity`
 * makes when no proxy assertion came with the request.
 */
function createStore({
  post = [],
  creator = [],
  identityState = 'active',
  deleteError = null,
}: {
  post?: Row[];
  creator?: Row[];
  identityState?: string;
  deleteError?: { message: string } | null;
} = {}) {
  const tables: Record<string, Row[]> = {
    feed_user_post_feedback: post.map((row) => ({ reason: null, ...row })),
    feed_user_creator_feedback: creator.map((row) => ({ reason: null, ...row })),
  };
  const from = vi.fn((table: string) => {
    if (table === 'profiles') {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({ data: { identity_state: identityState }, error: null }),
      };
      return query;
    }
    if (!(table in tables)) throw new Error(`The undo route read ${table}.`);

    const filters: Array<(row: Row) => boolean> = [];
    const query = {
      delete: () => query,
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value);
        return query;
      },
      is: (column: string, value: null) => {
        filters.push((row) => row[column] === value);
        return query;
      },
      select: async (columns: string) => {
        if (deleteError) return { data: null, error: deleteError };
        const removed = tables[table].filter((row) => filters.every((matches) => matches(row)));
        tables[table] = tables[table].filter((row) => !removed.includes(row));
        return {
          data: removed.map((row) => Object.fromEntries(columns.split(',').map((column) => [column.trim(), row[column.trim()]]))),
          error: null,
        };
      },
    };
    return query;
  });
  const rpc = vi.fn();
  return { client: { from, rpc } as unknown as SupabaseClient, from, rpc, tables };
}

function userClient(user: { id: string; is_anonymous?: boolean } | null, error: Error | null = null) {
  return {
    auth: { getUser: vi.fn(async () => ({ data: { user }, error })) },
  } as unknown as SupabaseClient;
}

function allowed() {
  return vi.fn(async () => ({
    allowed: true,
    limit: 300,
    remaining: 299,
    retryAfterSeconds: 0,
    resetAt: '2026-10-14T06:00:00.000Z',
  }));
}

function undoRequest(body: unknown, headers: Record<string, string> = { Authorization: 'Bearer viewer-token' }) {
  return new Request(`http://localhost${UNDO_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function undo(
  store: ReturnType<typeof createStore>,
  body: unknown,
  {
    user = { id: 'viewer-1' },
    userError = null,
    headers,
    enforceBackendRateLimit: limiter = allowed(),
  }: {
    user?: { id: string; is_anonymous?: boolean } | null;
    userError?: Error | null;
    headers?: Record<string, string>;
    enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  } = {},
) {
  const createUserClient = vi.fn(() => userClient(user, userError));
  const createServiceClient = vi.fn(() => store.client);
  const response = await postShowcaseFeedFeedbackUndoRouteResponse({
    request: undoRequest(body, headers),
    dependencies: {
      createServiceClient,
      createUserClient,
      enforceBackendRateLimit: limiter,
      logError: vi.fn(),
    },
  });
  return { response, createServiceClient, createUserClient, enforceBackendRateLimit: limiter };
}

describe('showcase feed feedback undo route adapter', () => {
  it("deletes the caller's Not interested once, and says so, leaving every other row", async () => {
    const store = createStore({
      post: [
        { user_id: 'viewer-1', post_id: POST_A },
        { user_id: 'viewer-1', post_id: POST_B },
        { user_id: 'viewer-2', post_id: POST_A },
      ],
    });

    const first = await undo(store, { feedbackType: 'not_interested', postId: POST_A });
    expect(first.response.status).toBe(200);
    await expect(first.response.json()).resolves.toEqual({ ok: true, removed: true });
    expect(first.response.headers.get('Cache-Control')).toBe('private, no-store');
    // The feed events budget, per account, as the events this takes back.
    expect(first.enforceBackendRateLimit).toHaveBeenCalledWith(store.client, expect.objectContaining({
      scope: 'showcase-feed:event',
      key: 'viewer-1',
    }));

    const second = await undo(store, { feedbackType: 'not_interested', postId: POST_A });
    expect(second.response.status).toBe(200);
    await expect(second.response.json()).resolves.toEqual({ ok: true, removed: false });

    expect(store.tables.feed_user_post_feedback).toEqual([
      { user_id: 'viewer-1', post_id: POST_B, reason: null },
      { user_id: 'viewer-2', post_id: POST_A, reason: null },
    ]);
    // A preference delete, not a feed event: nothing is written to the facts.
    expect(store.from.mock.calls.map(([table]) => table)).not.toContain('feed_events');
    expect(store.rpc).not.toHaveBeenCalled();
  });

  it("takes back the caller's Hide of one creator only", async () => {
    const store = createStore({
      creator: [
        { user_id: 'viewer-1', creator_user_id: CREATOR_A },
        { user_id: 'viewer-1', creator_user_id: CREATOR_B },
        { user_id: 'viewer-2', creator_user_id: CREATOR_A },
      ],
    });

    const { response } = await undo(store, { feedbackType: 'hide_creator', creatorId: CREATOR_A });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, removed: true });
    expect(store.tables.feed_user_creator_feedback).toEqual([
      { user_id: 'viewer-1', creator_user_id: CREATOR_B, reason: null },
      { user_id: 'viewer-2', creator_user_id: CREATOR_A, reason: null },
    ]);
  });

  it("counts an app guest's anonymous session as the user it is", async () => {
    const store = createStore({ post: [{ user_id: 'guest-1', post_id: POST_A }] });

    const { response } = await undo(
      store,
      { feedbackType: 'not_interested', postId: POST_A },
      { user: { id: 'guest-1', is_anonymous: true } },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, removed: true });
    expect(store.tables.feed_user_post_feedback).toEqual([]);
  });

  it("keeps a report's exclusion when a Not interested on the same post is taken back", async () => {
    const store = createStore({ post: [{ user_id: 'viewer-1', post_id: POST_A, reason: 'reported' }] });

    const { response } = await undo(store, { feedbackType: 'not_interested', postId: POST_A });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, removed: false });
    expect(store.tables.feed_user_post_feedback).toEqual([
      { user_id: 'viewer-1', post_id: POST_A, reason: 'reported' },
    ]);
  });

  it('answers 401 without a token, before any client or database work', async () => {
    const store = createStore({ post: [{ user_id: 'viewer-1', post_id: POST_A }] });

    const { response, createServiceClient, createUserClient, enforceBackendRateLimit } = await undo(
      store,
      { feedbackType: 'not_interested', postId: POST_A },
      { headers: {} },
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(createUserClient).not.toHaveBeenCalled();
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(enforceBackendRateLimit).not.toHaveBeenCalled();
    expect(store.tables.feed_user_post_feedback).toHaveLength(1);
  });

  it('answers 401 for a token Auth does not accept, and deletes nothing', async () => {
    const store = createStore({ post: [{ user_id: 'viewer-1', post_id: POST_A }] });

    const { response, enforceBackendRateLimit } = await undo(
      store,
      { feedbackType: 'not_interested', postId: POST_A },
      { user: null, userError: new AuthApiError('invalid JWT', 401, 'bad_jwt') },
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(enforceBackendRateLimit).not.toHaveBeenCalled();
    expect(store.tables.feed_user_post_feedback).toHaveLength(1);
  });

  it('refuses a guest session that has been linked to an account', async () => {
    const store = createStore({
      post: [{ user_id: 'guest-1', post_id: POST_A }],
      identityState: 'merged',
    });

    const { response } = await undo(
      store,
      { feedbackType: 'not_interested', postId: POST_A },
      { user: { id: 'guest-1', is_anonymous: true } },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'SESSION_MERGED' });
    expect(store.tables.feed_user_post_feedback).toHaveLength(1);
  });

  it.each([
    ['malformed JSON', '{"feedbackType":', 'Invalid JSON payload.'],
    ['an array', [{ feedbackType: 'not_interested', postId: POST_A }], 'Invalid feed preference undo payload.'],
    ['another feedback type', { feedbackType: 'report', postId: POST_A }, 'feedbackType must be not_interested or hide_creator.'],
    ['a Not interested without its post', { feedbackType: 'not_interested', creatorId: CREATOR_A }, 'Undoing Not interested needs a valid postId.'],
    ['a Hide without its creator', { feedbackType: 'hide_creator', postId: POST_A }, 'Undoing Hide needs a valid creatorId.'],
    ['an id that is not a UUID', { feedbackType: 'not_interested', postId: 'post-1' }, 'Undoing Not interested needs a valid postId.'],
  ])('answers 400 for %s and deletes nothing', async (_label, body, error) => {
    const store = createStore({ post: [{ user_id: 'viewer-1', post_id: POST_A }] });

    const { response } = await undo(store, body);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error });
    expect(store.tables.feed_user_post_feedback).toHaveLength(1);
  });

  it('answers 413 for a body far larger than an undo', async () => {
    const store = createStore();

    const { response } = await undo(store, {
      feedbackType: 'not_interested',
      postId: POST_A,
      padding: 'x'.repeat(SHOWCASE_FEED_FEEDBACK_UNDO_REQUEST_BODY_MAX_BYTES),
    });

    expect(response.status).toBe(413);
  });

  it('answers 429 once the feed events budget is spent, before reading the body', async () => {
    const store = createStore({ post: [{ user_id: 'viewer-1', post_id: POST_A }] });
    const enforceBackendRateLimit = vi.fn(async () => {
      throw new BackendRateLimitError({
        allowed: false,
        limit: 300,
        remaining: 0,
        retryAfterSeconds: 42,
        resetAt: '2026-10-14T06:10:00.000Z',
      });
    });

    const { response } = await undo(
      store,
      { feedbackType: 'not_interested', postId: POST_A },
      { enforceBackendRateLimit },
    );

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 42 });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(store.tables.feed_user_post_feedback).toHaveLength(1);
  });

  it('answers 500 when the delete fails', async () => {
    const store = createStore({
      post: [{ user_id: 'viewer-1', post_id: POST_A }],
      deleteError: { message: 'connection reset' },
    });

    const { response } = await undo(store, { feedbackType: 'not_interested', postId: POST_A });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Failed to undo the feed preference.' });
  });
});

describe('who may call the undo and newest-post routes', () => {
  function identityClient({ anonymous, state = 'active' }: { anonymous: boolean; state?: string }) {
    return {
      auth: {
        getClaims: vi.fn(async () => ({
          data: {
            claims: {
              sub: '11111111-1111-4111-8111-111111111111',
              aud: 'authenticated',
              role: 'authenticated',
              session_id: '22222222-2222-4222-8222-222222222222',
              is_anonymous: anonymous,
              exp: Math.floor(Date.now() / 1000) + 3_600,
            },
          },
          error: null,
        })),
      },
      rpc: vi.fn(async () => ({
        data: { state, created_at: '2026-10-01T00:00:00+00:00', banned: false, session_valid: true },
        error: null,
      })),
    };
  }

  function proxiedUndo() {
    return new NextRequest(`https://magicbooklet.test${UNDO_PATH}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer app-token' },
    });
  }

  it('lists the undo for guests and registered users, and the probe as public', () => {
    expect(routeIdentityPolicy(UNDO_PATH)).toBe('guest');
    expect(routeIdentityPolicy('/api/showcase/feed/newest')).toBe('public');
  });

  it("admits an app guest's token to the undo, where a registered-only route would answer 403", async () => {
    await expect(guardUserFacingRouteIdentity(proxiedUndo(), {
      createUserClient: () => identityClient({ anonymous: true }),
    })).resolves.toBeNull();
    await expect(guardUserFacingRouteIdentity(proxiedUndo(), {
      createUserClient: () => identityClient({ anonymous: false }),
    })).resolves.toBeNull();

    const merged = await guardUserFacingRouteIdentity(proxiedUndo(), {
      createUserClient: () => identityClient({ anonymous: true, state: 'merged' }),
    });
    expect(merged?.status).toBe(409);
  });
});
