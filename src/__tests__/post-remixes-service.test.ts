import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('@/lib/showcase-feed', () => ({ getShowcaseFeedItemsByPostIds: vi.fn() }));
vi.mock('@/lib/moderation-service', () => ({ isUserRelationshipBlocked: vi.fn() }));

import {
  listPostRemixes,
  normalizePostRemixesLimit,
  normalizePostRemixesOffset,
  POST_REMIXES_MAX_PAGE_SIZE,
} from '@/lib/post-remixes-service';
import { getPostRemixesRouteResponse } from '@/lib/post-remixes-route-adapter-service';
import { routeIdentityPolicyForPathname } from '@/lib/route-identity-policy';
import type { ShowcaseFeedItem } from '@/lib/showcase';

const POST_ID = '11111111-1111-4111-8111-111111111111';

type Filter = { kind: string; column?: string; value?: unknown };

/**
 * `posts` answering the remixed post's read (maybeSingle) and the list's read
 * (a range), recording every filter each one sent.
 */
function database({
  post = { id: POST_ID, user_id: 'cora' },
  remixIds = [] as string[],
  failPost = false,
  failList = false,
} = {}) {
  const queries: Filter[][] = [];
  const from = vi.fn(() => {
    const filters: Filter[] = [];
    queries.push(filters);
    const query = {
      select: (columns: string) => { filters.push({ kind: 'select', value: columns }); return query; },
      eq: (column: string, value: unknown) => { filters.push({ kind: 'eq', column, value }); return query; },
      in: (column: string, value: unknown) => { filters.push({ kind: 'in', column, value }); return query; },
      is: (column: string, value: unknown) => { filters.push({ kind: 'is', column, value }); return query; },
      order: (column: string) => { filters.push({ kind: 'order', column }); return query; },
      maybeSingle: async () => (failPost ? { data: null, error: { message: 'timeout' } } : { data: post, error: null }),
      range: async (start: number, end: number) => {
        filters.push({ kind: 'range', value: [start, end] });
        return failList
          ? { data: null, error: { message: 'timeout' } }
          : { data: remixIds.slice(start, end + 1).map((id) => ({ id })), error: null };
      },
    };
    return query;
  });
  return { client: { from } as unknown as SupabaseClient, queries };
}

function card(id: string) {
  return { id } as ShowcaseFeedItem;
}

function dependencies(blocked = false) {
  return {
    isUserRelationshipBlocked: vi.fn(async () => blocked),
    getShowcaseFeedItemsByPostIds: vi.fn(async ({ postIds }: { postIds: string[] }) => postIds.map(card)),
  };
}

describe('a post\'s remixes list', () => {
  it('lists posted remixes only, newest first, a page at a time', async () => {
    const db = database({ remixIds: ['r1', 'r2', 'r3'] });
    const deps = dependencies();
    const result = await listPostRemixes({
      adminSupabase: db.client,
      postId: POST_ID,
      viewerUserId: null,
      countryCode: 'IN',
      limit: 2,
      offset: 0,
      dependencies: deps,
    });

    expect(result).toEqual({
      ok: true,
      body: {
        success: true,
        items: [card('r1'), card('r2')],
        pageInfo: { hasMore: true, nextOffset: 2, limit: 2, offset: 0 },
      },
    });
    const list = db.queries[1];
    expect(list).toEqual(expect.arrayContaining([
      { kind: 'eq', column: 'remix_parent_post_id', value: POST_ID },
      { kind: 'eq', column: 'visibility', value: 'public' },
      { kind: 'eq', column: 'review_status', value: 'visible' },
      { kind: 'is', column: 'archived_at', value: null },
      { kind: 'order', column: 'created_at' },
      { kind: 'range', value: [0, 2] },
    ]));
    // Drawn as every public read draws a post, for this viewer.
    expect(deps.getShowcaseFeedItemsByPostIds).toHaveBeenCalledWith({ postIds: ['r1', 'r2'], viewerUserId: null, countryCode: 'IN' });
  });

  it('says when the last page is reached', async () => {
    const db = database({ remixIds: ['r1', 'r2', 'r3'] });
    const result = await listPostRemixes({
      adminSupabase: db.client, postId: POST_ID, viewerUserId: null, countryCode: null, limit: 2, offset: 2,
      dependencies: dependencies(),
    });
    expect(result).toMatchObject({ ok: true, body: { items: [card('r3')], pageInfo: { hasMore: false, nextOffset: null } } });
  });

  it('reads the remixed post as its link opens it', async () => {
    const db = database();
    await listPostRemixes({
      adminSupabase: db.client, postId: POST_ID.toUpperCase(), viewerUserId: null, countryCode: null, limit: 24, offset: 0,
      dependencies: dependencies(),
    });
    expect(db.queries[0]).toEqual(expect.arrayContaining([
      { kind: 'eq', column: 'id', value: POST_ID },
      { kind: 'in', column: 'visibility', value: ['public', 'unlisted'] },
      { kind: 'eq', column: 'review_status', value: 'visible' },
      { kind: 'is', column: 'archived_at', value: null },
    ]));
  });

  it.each([
    ['an id that is no post id', { postId: '../profile' }, {}],
    ['a post anyone may not open', {}, { post: null }],
  ])('answers 404 for %s', async (_case, params, data) => {
    const db = database(data as Parameters<typeof database>[0]);
    const result = await listPostRemixes({
      adminSupabase: db.client, postId: POST_ID, viewerUserId: null, countryCode: null, limit: 24, offset: 0,
      dependencies: dependencies(),
      ...params,
    });
    expect(result).toEqual({ ok: false, status: 404, body: { error: 'Post not found.' } });
  });

  it('answers 404 across a block, either way round', async () => {
    const deps = dependencies(true);
    const result = await listPostRemixes({
      adminSupabase: database({ remixIds: ['r1'] }).client, postId: POST_ID, viewerUserId: 'viewer', countryCode: null,
      limit: 24, offset: 0, dependencies: deps,
    });
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(deps.isUserRelationshipBlocked).toHaveBeenCalledWith(expect.objectContaining({ firstUserId: 'viewer', secondUserId: 'cora' }));
    expect(deps.getShowcaseFeedItemsByPostIds).not.toHaveBeenCalled();
  });

  it('shows nothing when the block cannot be checked', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const deps = { ...dependencies(), isUserRelationshipBlocked: vi.fn(async () => { throw new Error('down'); }) };
    const result = await listPostRemixes({
      adminSupabase: database({ remixIds: ['r1'] }).client, postId: POST_ID, viewerUserId: 'viewer', countryCode: null,
      limit: 24, offset: 0, dependencies: deps,
    });
    expect(result).toMatchObject({ ok: false, status: 500 });
    log.mockRestore();
  });

  it('asks the creator of the post about nobody', async () => {
    const deps = dependencies(true);
    await listPostRemixes({
      adminSupabase: database().client, postId: POST_ID, viewerUserId: 'cora', countryCode: null,
      limit: 24, offset: 0, dependencies: deps,
    });
    expect(deps.isUserRelationshipBlocked).not.toHaveBeenCalled();
  });

  it.each([['failPost'], ['failList']])('answers 500 when a read fails (%s)', async (failure) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await listPostRemixes({
      adminSupabase: database({ [failure]: true }).client, postId: POST_ID, viewerUserId: null, countryCode: null,
      limit: 24, offset: 0, dependencies: dependencies(),
    });
    expect(result).toEqual({ ok: false, status: 500, body: { error: 'Failed to load remixes.' } });
    log.mockRestore();
  });

  it('pages within bounds', () => {
    expect(normalizePostRemixesLimit(null)).toBe(24);
    expect(normalizePostRemixesLimit('500')).toBe(POST_REMIXES_MAX_PAGE_SIZE);
    expect(normalizePostRemixesLimit('-3')).toBe(24);
    expect(normalizePostRemixesOffset('48')).toBe(48);
    expect(normalizePostRemixesOffset('x')).toBe(0);
  });
});

describe('GET /api/showcase/posts/:postId/remixes', () => {
  it('is public, as the post read by id is', () => {
    expect(routeIdentityPolicyForPathname('/api/showcase/posts/abc/remixes')).toBe('public');
  });

  it('keys a signed-out reader\'s rate limit on their network and caches the page at the edge', async () => {
    const enforceBackendRateLimit = vi.fn(async () => undefined);
    const listPostRemixes = vi.fn(async () => ({
      ok: true as const,
      body: { success: true as const, items: [], pageInfo: { hasMore: false, nextOffset: null, limit: 24, offset: 0 } },
    }));
    const response = await getPostRemixesRouteResponse({
      request: new Request(`http://localhost/api/showcase/posts/${POST_ID}/remixes?limit=12&offset=24`, {
        headers: { 'x-vercel-ip-country': 'IN' },
      }),
      context: { params: Promise.resolve({ postId: POST_ID }) },
      dependencies: {
        createServiceClient: () => ({}) as never,
        enforceBackendRateLimit,
        getFeedNetworkKeyHash: () => 'network-hash',
        listPostRemixes,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, s-maxage=60, stale-while-revalidate=300');
    expect(enforceBackendRateLimit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      scope: 'showcase-post-remixes:read',
      key: 'network-hash',
    }));
    expect(listPostRemixes).toHaveBeenCalledWith(expect.objectContaining({
      postId: POST_ID,
      viewerUserId: null,
      countryCode: 'IN',
      limit: 12,
      offset: 24,
    }));
  });

  it('answers the service\'s refusal', async () => {
    const response = await getPostRemixesRouteResponse({
      request: new Request(`http://localhost/api/showcase/posts/${POST_ID}/remixes`),
      context: { params: Promise.resolve({ postId: POST_ID }) },
      dependencies: {
        createServiceClient: () => ({}) as never,
        enforceBackendRateLimit: vi.fn(async () => undefined),
        getFeedNetworkKeyHash: () => 'network-hash',
        listPostRemixes: vi.fn(async () => ({ ok: false as const, status: 404 as const, body: { error: 'Post not found.' } })),
      },
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Post not found.' });
  });
});
