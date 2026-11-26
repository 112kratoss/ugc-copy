import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { API_CACHE_CONTROL } from '@/lib/api-cache';
import { BackendRateLimitError, POST_COMMENTS_READ_RATE_LIMIT } from '@/lib/backend-rate-limit';
import { buildCommentsQuery } from '@/lib/post-comments-client';
import {
  createPostCommentRouteResponse,
  deletePostCommentRouteResponse,
  updatePostCommentRouteResponse,
  getPostCommentsRouteResponse,
} from '@/lib/post-comments-route-adapter-service';
import type {
  listPostCommentsForRoute as ListPostCommentsForRoute,
  removePostCommentForRoute as RemovePostCommentForRoute,
} from '@/lib/post-comments-service';

import mobileApiContract from '../../contracts/mobile-api-v1.json';

const contract = mobileApiContract.endpoints.listPostComments;

const POST_ID = 'post-1';
const COMMENT_ID = 'comment-1';

function createUserClient(userId: string | null = 'viewer-1') {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: userId ? { id: userId } : null },
        error: userId ? null : new Error('missing session'),
      })),
    },
  } as unknown as SupabaseClient;
}

/** A guest's token resolves to a real user, flagged anonymous. */
function createGuestClient(userId = 'guest-1') {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: userId, is_anonymous: true } },
        error: null,
      })),
    },
  } as unknown as SupabaseClient;
}

function commentsContext() {
  return { params: Promise.resolve({ postId: POST_ID }) };
}

function commentContext() {
  return { params: Promise.resolve({ postId: POST_ID, commentId: COMMENT_ID }) };
}

function emptyPage() {
  return {
    ok: true as const,
    status: 200 as const,
    body: {
      postId: POST_ID,
      postCreatorId: 'creator-1',
      commentCount: 0,
      commentsLocked: false,
      comments: [],
      pageInfo: { hasMore: false, nextOffset: null, limit: 20, offset: 0 },
    },
  };
}

describe('getPostCommentsRouteResponse', () => {
  it('serves anonymous readers without resolving a viewer', async () => {
    const createUserClientSpy = vi.fn(() => createUserClient(null));
    const listPostCommentsForRoute = vi.fn<typeof ListPostCommentsForRoute>()
      .mockResolvedValue(emptyPage());

    const response = await getPostCommentsRouteResponse({
      context: commentsContext(),
      request: new Request(`http://localhost/api/showcase/posts/${POST_ID}/comments`),
      dependencies: {
        createServiceClient: vi.fn(() => ({}) as SupabaseClient),
        createUserClient: createUserClientSpy,
        enforceBackendRateLimit: vi.fn(),
        getFeedNetworkKeyHash: () => 'network-hash',
        listPostCommentsForRoute,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Vary')).toContain('Authorization');
    expect(createUserClientSpy).not.toHaveBeenCalled();
    expect(listPostCommentsForRoute.mock.calls[0][0]).toMatchObject({ viewerUserId: null });
  });

  // The proxy lets a guest's token through to this read
  // (GUEST_READABLE_REGISTERED_ROUTES); the route must then serve it. A guest's
  // app sends that token with every request, and used to be told 403.
  it('serves a guest reader as it serves any visitor', async () => {
    const enforceBackendRateLimit = vi.fn();
    const listPostCommentsForRoute = vi.fn<typeof ListPostCommentsForRoute>()
      .mockResolvedValue(emptyPage());

    const response = await getPostCommentsRouteResponse({
      context: commentsContext(),
      request: new Request(`http://localhost/api/showcase/posts/${POST_ID}/comments`, {
        headers: { authorization: 'Bearer guest-token' },
      }),
      dependencies: {
        createServiceClient: vi.fn(() => ({}) as SupabaseClient),
        createUserClient: () => createGuestClient('guest-1'),
        enforceBackendRateLimit,
        getFeedNetworkKeyHash: () => 'network-hash',
        listPostCommentsForRoute,
      },
    });

    expect(response.status).toBe(200);
    expect(listPostCommentsForRoute).toHaveBeenCalledTimes(1);
    // Counted against the guest's own identity, not the network it shares.
    expect(enforceBackendRateLimit.mock.calls[0][1]).toMatchObject({ key: 'guest-1' });
  });

  it('passes normalized paging and sort params through to the service', async () => {
    const listPostCommentsForRoute = vi.fn<typeof ListPostCommentsForRoute>()
      .mockResolvedValue(emptyPage());

    await getPostCommentsRouteResponse({
      context: commentsContext(),
      request: new Request(
        `http://localhost/api/showcase/posts/${POST_ID}/comments?sort=newest&limit=500&offset=40&parentId=parent-1`,
        { headers: { authorization: 'Bearer token' } },
      ),
      dependencies: {
        createServiceClient: vi.fn(() => ({}) as SupabaseClient),
        createUserClient: () => createUserClient('viewer-1'),
        enforceBackendRateLimit: vi.fn(),
        getFeedNetworkKeyHash: () => 'network-hash',
        listPostCommentsForRoute,
      },
    });

    expect(listPostCommentsForRoute.mock.calls[0][0]).toMatchObject({
      postId: POST_ID,
      viewerUserId: 'viewer-1',
      parentId: 'parent-1',
      sort: 'newest',
      limit: 50,
      offset: 40,
    });
  });

  it('keeps authenticated reads out of shared caches', async () => {
    const response = await getPostCommentsRouteResponse({
      context: commentsContext(),
      request: new Request(`http://localhost/api/showcase/posts/${POST_ID}/comments`, {
        headers: { authorization: 'Bearer token' },
      }),
      dependencies: {
        createServiceClient: vi.fn(() => ({}) as SupabaseClient),
        createUserClient: () => createUserClient('viewer-1'),
        enforceBackendRateLimit: vi.fn(),
        getFeedNetworkKeyHash: () => 'network-hash',
        listPostCommentsForRoute: vi.fn(async () => emptyPage()),
      },
    });

    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Vary')).toContain('Authorization');
  });

  it('propagates a service failure status', async () => {
    const response = await getPostCommentsRouteResponse({
      context: commentsContext(),
      request: new Request(`http://localhost/api/showcase/posts/${POST_ID}/comments`),
      dependencies: {
        createServiceClient: vi.fn(() => ({}) as SupabaseClient),
        createUserClient: () => createUserClient(null),
        enforceBackendRateLimit: vi.fn(),
        getFeedNetworkKeyHash: () => 'network-hash',
        listPostCommentsForRoute: vi.fn(async () => ({
          ok: false as const,
          status: 404 as const,
          body: { error: 'Post not found.' },
        })),
      },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Post not found.' });
  });
});

// Every signed-out view of a post page asked for its thread, and each request ran the function, the
// thread's reads and a rate-limit row, for an answer that is the same for every visitor. The web now
// asks a signed-out reader's read as `scope=public`, which the route lets Vercel's CDN keep for a
// minute and serve a minute stale while it refreshes; any request with a session gets the per-viewer
// read, private, no-store, as before.
describe('getPostCommentsRouteResponse: the signed-out read the edge may keep (scope=public)', () => {
  const PUBLIC_QUERY = 'limit=20&offset=0&sort=top&scope=public';
  const PUBLIC_READ = `http://localhost/api/showcase/posts/${POST_ID}/comments?${PUBLIC_QUERY}`;

  /** The service as the route reaches it: a reader's own reaction only for a reader it names. */
  function viewerAwareList() {
    return vi.fn<typeof ListPostCommentsForRoute>(async ({ viewerUserId }) => ({
      ok: true as const,
      status: 200 as const,
      body: {
        ...emptyPage().body,
        commentCount: 1,
        comments: [{
          id: COMMENT_ID,
          parentId: null,
          body: 'hello',
          status: 'active' as const,
          createdAt: '2026-11-20T00:00:00.000Z',
          replyCount: 0,
          author: { id: 'author-1', username: 'author', displayName: 'Author', avatarUrl: null },
          likeCount: 3,
          viewerReaction: viewerUserId ? 'like' as const : null,
          editedAt: null,
          hearted: false,
          pinned: false,
        }],
      },
    }));
  }

  async function read(
    headers: Record<string, string> = {},
    {
      url = PUBLIC_READ,
      list = viewerAwareList(),
      enforceBackendRateLimit = vi.fn(),
    }: {
      url?: string;
      list?: ReturnType<typeof viewerAwareList>;
      enforceBackendRateLimit?: ReturnType<typeof vi.fn>;
    } = {},
  ) {
    const userClient = vi.fn(() => createUserClient('viewer-1'));
    const response = await getPostCommentsRouteResponse({
      context: commentsContext(),
      request: new Request(url, { headers }),
      dependencies: {
        createServiceClient: vi.fn(() => ({}) as SupabaseClient),
        createUserClient: userClient,
        enforceBackendRateLimit: enforceBackendRateLimit as never,
        getFeedNetworkKeyHash: () => 'network-hash',
        listPostCommentsForRoute: list,
      },
    });
    return { response, userClient, list, enforceBackendRateLimit };
  }

  it('answers a visitor with no session the shared answer: kept at the edge, nobody resolved, the network counted on a miss', async () => {
    const { response, userClient, list, enforceBackendRateLimit } = await read({ 'x-request-id': 'comments-public-1' });

    expect(response.status).toBe(200);
    // Fresh at the edge for a minute, served a minute stale while it refreshes, never kept by a browser.
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=0, s-maxage=60, stale-while-revalidate=60');
    expect(response.headers.get('Cache-Control')).toBe(API_CACHE_CONTROL.publicMinuteEdge);
    expect(response.headers.get('Cache-Control')).toBe(contract.publicScope.cacheControl);
    expect(response.headers.get('Vary')).toBe(contract.vary);
    // Vercel's CDN keeps no answer that sets a cookie.
    expect(response.headers.get('Set-Cookie')).toBeNull();
    expect(response.headers.get('x-request-id')).toBe('comments-public-1');
    expect(userClient).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledTimes(1);
    expect(list.mock.calls[0][0]).toMatchObject({
      postId: POST_ID, viewerUserId: null, parentId: null, sort: 'top', limit: 20, offset: 0,
    });
    // The function runs only on a miss, and then it still counts the visitor's network.
    expect(enforceBackendRateLimit).toHaveBeenCalledTimes(1);
    expect(enforceBackendRateLimit.mock.calls[0][1]).toEqual({ ...POST_COMMENTS_READ_RATE_LIMIT, key: 'network-hash' });
    // Nothing in it is a reader's own.
    const body = await response.json() as { comments: Array<{ viewerReaction: unknown }> };
    expect(body.comments.map((item) => item.viewerReaction)).toEqual([null]);
  });

  it('is the read the web asks for a reader with no session', () => {
    expect(buildCommentsQuery({ offset: 0, limit: 20, sort: 'top', scope: 'public' })).toBe(PUBLIC_QUERY);
    expect(new URL(PUBLIC_READ).searchParams.get('scope')).toBe(contract.publicScope.query.scope);
  });

  it('answers a token on the same address privately, with that reader\'s own answer', async () => {
    const { response, userClient, list, enforceBackendRateLimit } = await read({ authorization: 'Bearer token' });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Cache-Control')).toBe(contract.cacheControl);
    expect(response.headers.get('Vary')).toBe('Authorization');
    expect(userClient).toHaveBeenCalledTimes(1);
    expect(list.mock.calls[0][0]).toMatchObject({ viewerUserId: 'viewer-1' });
    expect(enforceBackendRateLimit.mock.calls[0][1]).toMatchObject({ key: 'viewer-1' });
    const body = await response.json() as { comments: Array<{ viewerReaction: unknown }> };
    expect(body.comments.map((item) => item.viewerReaction)).toEqual(['like']);
  });

  it.each([
    ['an empty Authorization header', { authorization: '' }],
    ['a Supabase session cookie', { cookie: 'theme=dark; sb-project-ref-auth-token=base64-eyJ1c2VyIjp7fX0' }],
    ['a session cookie in chunks', { cookie: 'sb-project-ref-auth-token.0=base64-eyJ1; sb-project-ref-auth-token.1=c2VyIjp7fX0' }],
    // Read without the configured project, so any project's session keeps the answer private.
    ['another project\'s session cookie', { cookie: 'sb-127-auth-token=base64-eyJ1c2VyIjp7fX0' }],
    // A sign-in left half done keeps its PKCE verifier cookie: still a session's, still private.
    ['a sign-in verifier cookie', { cookie: 'sb-project-ref-auth-token-code-verifier=abc123' }],
  ])('answers a request with %s privately, as today\'s read, even when it asks for the shared one', async (_label, headers) => {
    const { response } = await read(headers);

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Vary')).toBe('Authorization');
  });

  it('keeps the read without the scope, and any other scope, private for a visitor too', async () => {
    for (const url of [
      `http://localhost/api/showcase/posts/${POST_ID}/comments?limit=20&offset=0&sort=top`,
      `http://localhost/api/showcase/posts/${POST_ID}/comments?limit=20&offset=0&sort=top&scope=everyone`,
    ]) {
      const { response } = await read({}, { url });
      expect(response.headers.get('Cache-Control'), url).toBe('private, no-store');
    }
  });

  it('keeps every refusal of the shared read out of shared caches', async () => {
    const missing = await read({}, {
      list: vi.fn<typeof ListPostCommentsForRoute>(async () => ({
        ok: false as const, status: 404 as const, body: { error: 'Post not found.' },
      })) as unknown as ReturnType<typeof viewerAwareList>,
    });
    expect(missing.response.status).toBe(404);
    expect(missing.response.headers.get('Cache-Control')).toBe('private, no-store');

    const limited = await read({}, {
      enforceBackendRateLimit: vi.fn(async () => {
        throw new BackendRateLimitError({
          allowed: false, limit: 300, remaining: 0, retryAfterSeconds: 90, resetAt: '2026-11-20T12:10:00.000Z',
        });
      }),
    });
    expect(limited.response.status).toBe(429);
    expect(limited.response.headers.get('Retry-After')).toBe('90');
    // One network's refusal must never be served to every visitor.
    expect(limited.response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(limited.list).not.toHaveBeenCalled();
  });
});

describe('createPostCommentRouteResponse', () => {
  it('rejects unauthenticated writes before creating an admin client', async () => {
    const createServiceClient = vi.fn();
    const createPostCommentForRoute = vi.fn();

    const response = await createPostCommentRouteResponse({
      context: commentsContext(),
      request: new Request(`http://localhost/api/showcase/posts/${POST_ID}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-request-id': 'comment-auth-1' },
        body: '{',
      }),
      dependencies: {
        createServiceClient,
        createUserClient: () => createUserClient(null),
        createPostCommentForRoute,
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('comment-auth-1');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(createPostCommentForRoute).not.toHaveBeenCalled();
  });

  // The second line behind the proxy's 403: reading is anyone's, writing is not.
  it('refuses a guest writer before creating an admin client', async () => {
    const createServiceClient = vi.fn();
    const createPostCommentForRoute = vi.fn();

    const response = await createPostCommentRouteResponse({
      context: commentsContext(),
      request: new Request(`http://localhost/api/showcase/posts/${POST_ID}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: 'Bearer guest-token' },
        body: JSON.stringify({ body: 'hello' }),
      }),
      dependencies: {
        createServiceClient,
        createUserClient: () => createGuestClient(),
        createPostCommentForRoute,
      },
    });

    expect(response.status).toBe(401);
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(createPostCommentForRoute).not.toHaveBeenCalled();
  });

  it('delegates the author, post id, and a lazy body reader', async () => {
    const createPostCommentForRoute = vi.fn(async ({ readBody }: { readBody: () => Promise<unknown> }) => {
      await expect(readBody()).resolves.toEqual({ body: 'hello' });
      return {
        ok: true as const,
        status: 201 as const,
        body: {
          success: true as const,
          commentCount: 1,
          comment: {
            id: COMMENT_ID,
            parentId: null,
            body: 'hello',
            status: 'active' as const,
            createdAt: '2026-07-27T12:00:00.000Z',
            replyCount: 0,
            author: null,
            likeCount: 0,
            viewerReaction: null,
            editedAt: null,
            hearted: false,
            pinned: false,
          },
        },
      };
    });

    const response = await createPostCommentRouteResponse({
      context: commentsContext(),
      request: new Request(`http://localhost/api/showcase/posts/${POST_ID}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: 'Bearer token' },
        body: JSON.stringify({ body: 'hello' }),
      }),
      dependencies: {
        createServiceClient: vi.fn(() => ({}) as SupabaseClient),
        createUserClient: () => createUserClient('author-1'),
        createPostCommentForRoute,
      },
    });

    expect(response.status).toBe(201);
    expect(createPostCommentForRoute.mock.calls[0][0]).toMatchObject({
      postId: POST_ID,
      authorUserId: 'author-1',
    });
  });

  it('hands the service a scheduler, so the comment\'s feed event goes out behind the answer', async () => {
    const runAfterResponse = vi.fn();
    const createPostCommentForRoute = vi.fn(async ({ readBody }: { readBody: () => Promise<unknown> }) => {
      // The body reaches the service whole, delivery id included.
      await expect(readBody()).resolves.toEqual({ body: 'hello', deliveryId: '812' });
      return { ok: false as const, status: 404 as const, body: { error: 'Post not found.' } };
    });

    await createPostCommentRouteResponse({
      context: commentsContext(),
      request: new Request(`http://localhost/api/showcase/posts/${POST_ID}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: 'Bearer token' },
        body: JSON.stringify({ body: 'hello', deliveryId: '812' }),
      }),
      dependencies: {
        createServiceClient: vi.fn(() => ({}) as SupabaseClient),
        createUserClient: () => createUserClient('author-1'),
        createPostCommentForRoute,
        runAfterResponse,
      },
    });

    expect(createPostCommentForRoute).toHaveBeenCalledTimes(1);
    expect(createPostCommentForRoute.mock.calls[0][0]).toMatchObject({ runAfterResponse });
  });

  it('renders a rate limited create as a 429 with retry headers', async () => {
    const rateLimitError = new BackendRateLimitError({
      allowed: false,
      limit: 20,
      remaining: 0,
      retryAfterSeconds: 120,
      resetAt: '2026-07-27T12:10:00.000Z',
    });

    const response = await createPostCommentRouteResponse({
      context: commentsContext(),
      request: new Request(`http://localhost/api/showcase/posts/${POST_ID}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: 'Bearer token' },
        body: JSON.stringify({ body: 'hello' }),
      }),
      dependencies: {
        createServiceClient: vi.fn(() => ({}) as SupabaseClient),
        createUserClient: () => createUserClient('author-1'),
        createPostCommentForRoute: vi.fn(async () => ({
          ok: false as const,
          status: 429 as const,
          rateLimitError,
          body: { error: 'Too many comments.', code: 'RATE_LIMITED' as const },
        })),
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('120');
  });
});

describe('deletePostCommentRouteResponse', () => {
  it('rejects unauthenticated removals', async () => {
    const removePostCommentForRoute = vi.fn();

    const response = await deletePostCommentRouteResponse({
      context: commentContext(),
      request: new Request(
        `http://localhost/api/showcase/posts/${POST_ID}/comments/${COMMENT_ID}`,
        { method: 'DELETE' },
      ),
      dependencies: {
        createServiceClient: vi.fn(),
        createUserClient: () => createUserClient(null),
        removePostCommentForRoute,
      },
    });

    expect(response.status).toBe(401);
    expect(removePostCommentForRoute).not.toHaveBeenCalled();
  });

  it('delegates the actor, post id, and comment id', async () => {
    const removePostCommentForRoute = vi.fn<typeof RemovePostCommentForRoute>()
      .mockResolvedValue({
        ok: true as const,
        status: 200 as const,
        body: { success: true as const, status: 'removed_by_author' as const, commentCount: 0 },
      });

    const response = await deletePostCommentRouteResponse({
      context: commentContext(),
      request: new Request(
        `http://localhost/api/showcase/posts/${POST_ID}/comments/${COMMENT_ID}`,
        { method: 'DELETE', headers: { authorization: 'Bearer token' } },
      ),
      dependencies: {
        createServiceClient: vi.fn(() => ({}) as SupabaseClient),
        createUserClient: () => createUserClient('author-1'),
        removePostCommentForRoute,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(removePostCommentForRoute.mock.calls[0][0]).toMatchObject({
      postId: POST_ID,
      commentId: COMMENT_ID,
      actorUserId: 'author-1',
    });
  });
});

describe('updatePostCommentRouteResponse', () => {
  const patch = (headers: Record<string, string> = {}) => new Request(
    `http://localhost/api/showcase/posts/${POST_ID}/comments/${COMMENT_ID}`,
    { method: 'PATCH', headers, body: JSON.stringify({ reaction: 'like' }) },
  );

  it('refuses a visitor and a guest before creating an admin client', async () => {
    for (const userClient of [createUserClient(null), createGuestClient()]) {
      const updatePostCommentForRoute = vi.fn();
      const createServiceClient = vi.fn();

      const response = await updatePostCommentRouteResponse({
        context: commentContext(),
        request: patch({ authorization: 'Bearer token' }),
        dependencies: { createServiceClient, createUserClient: () => userClient, updatePostCommentForRoute },
      });

      // A like, a heart, a pin and an edit are an account's, as a comment is.
      expect(response.status).toBe(401);
      expect(updatePostCommentForRoute).not.toHaveBeenCalled();
      expect(createServiceClient).not.toHaveBeenCalled();
    }
  });

  it('delegates the actor, the ids and a lazy body reader, and keeps the answer out of caches', async () => {
    const updatePostCommentForRoute = vi.fn(async (input: { readBody: () => Promise<unknown> }) => ({
      ok: true as const,
      status: 200 as const,
      body: { success: true as const, read: await input.readBody(), unpinnedCommentId: null },
    }));

    const response = await updatePostCommentRouteResponse({
      context: commentContext(),
      request: patch({ authorization: 'Bearer token' }),
      dependencies: {
        createServiceClient: vi.fn(() => ({}) as SupabaseClient),
        createUserClient: () => createUserClient('reader-1'),
        updatePostCommentForRoute: updatePostCommentForRoute as never,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(updatePostCommentForRoute.mock.calls[0][0]).toMatchObject({
      postId: POST_ID,
      commentId: COMMENT_ID,
      actorUserId: 'reader-1',
    });
    expect(await response.json()).toMatchObject({ read: { reaction: 'like' } });
  });
});
