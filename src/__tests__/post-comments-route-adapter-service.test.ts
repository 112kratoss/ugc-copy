import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import {
  createPostCommentRouteResponse,
  deletePostCommentRouteResponse,
  getPostCommentsRouteResponse,
} from '@/lib/post-comments-route-adapter-service';
import type {
  listPostCommentsForRoute as ListPostCommentsForRoute,
  removePostCommentForRoute as RemovePostCommentForRoute,
} from '@/lib/post-comments-service';

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
        listPostCommentsForRoute,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Vary')).toContain('Authorization');
    expect(createUserClientSpy).not.toHaveBeenCalled();
    expect(listPostCommentsForRoute.mock.calls[0][0]).toMatchObject({ viewerUserId: null });
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
