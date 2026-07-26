import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import {
  createPostsRouteHandlers,
  getPostsRouteResponse,
  postPostsRouteResponse,
} from '@/lib/posts-route-adapter-service';

function createUserClient(userId: string | null = 'user-1') {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: userId ? { id: userId } : null },
        error: userId ? null : new Error('missing session'),
      })),
    },
  } as unknown as SupabaseClient;
}

describe('posts route adapter service', () => {
  it('rejects unauthenticated post creation before service-client creation or form parsing', async () => {
    const createServiceClient = vi.fn();
    const createOwnerPostForRoute = vi.fn();
    const request = new Request('http://localhost/api/posts', {
      method: 'POST',
      headers: { 'x-request-id': 'posts-auth-1' },
      body: new FormData(),
    });
    const formDataSpy = vi.spyOn(request, 'formData');

    const response = await postPostsRouteResponse({
      request,
      dependencies: {
        createOwnerPostForRoute,
        createServiceClient,
        createUserClient: () => createUserClient(null),
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('posts-auth-1');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(createOwnerPostForRoute).not.toHaveBeenCalled();
    expect(formDataSpy).not.toHaveBeenCalled();
  });

  it('creates owner posts through the post creation service with private no-store headers', async () => {
    const adminSupabase = { kind: 'admin' } as unknown as SupabaseClient;
    const createOwnerPostForRoute = vi.fn(async () => ({
      ok: true as const,
      body: {
        success: true as const,
        postId: 'post-1',
        visibility: 'private' as const,
        showcasePath: null,
        ownerPath: '/post/post-1/edit',
        resourceBundlePath: '/post/post-1/edit#recipe',
        resourceBundleStatus: null,
      },
    }));
    const request = new Request('http://localhost/api/posts', {
      method: 'POST',
      headers: { 'x-request-id': 'posts-create-1' },
      body: new FormData(),
    });

    const response = await postPostsRouteResponse({
      request,
      dependencies: {
        createOwnerPostForRoute,
        createServiceClient: vi.fn(() => adminSupabase),
        createUserClient: () => createUserClient('user-1'),
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('posts-create-1');
    await expect(response.json()).resolves.toEqual({
      success: true,
      postId: 'post-1',
      visibility: 'private',
      showcasePath: null,
      ownerPath: '/post/post-1/edit',
      resourceBundlePath: '/post/post-1/edit#recipe',
      resourceBundleStatus: null,
    });
    expect(createOwnerPostForRoute).toHaveBeenCalledWith({
      adminSupabase,
      ownerUserId: 'user-1',
      readFormData: expect.any(Function),
    });
  });

  it('maps post creation rate limits to standard backend rate-limit responses', async () => {
    const rateLimitError = new BackendRateLimitError({
      allowed: false,
      limit: 60,
      remaining: 0,
      retryAfterSeconds: 37,
      resetAt: '2026-06-23T13:00:00.000Z',
    });

    const response = await postPostsRouteResponse({
      request: new Request('http://localhost/api/posts', {
        method: 'POST',
        body: new FormData(),
      }),
      dependencies: {
        createOwnerPostForRoute: vi.fn(async () => ({
          ok: false as const,
          status: 429 as const,
          body: {
            error: rateLimitError.message,
            code: 'RATE_LIMITED' as const,
            retryAfterSeconds: 37,
            limit: 60,
            resetAt: '2026-06-23T13:00:00.000Z',
          },
          rateLimitError,
        })),
        createServiceClient: vi.fn(() => ({ rpc: vi.fn() }) as unknown as SupabaseClient),
        createUserClient: () => createUserClient('user-1'),
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('37');
    await expect(response.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 37,
      limit: 60,
    });
  });

  it('loads owner posts with authenticated user id and shaped route response', async () => {
    const posts = [{ id: 'post-1', visibility: 'public' }];
    const listOwnerPostsForRoute = vi.fn(async () => ({
      ok: true as const,
      posts,
      pageInfo: {
        hasMore: false,
        limit: null,
        nextOffset: null,
        offset: 0,
      },
    }));
    const request = new Request('http://localhost/api/posts?scope=owner&visibility=public');

    const response = await getPostsRouteResponse({
      request,
      dependencies: {
        createUserClient: () => createUserClient('user-1'),
        listOwnerPostsForRoute,
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      posts,
      pageInfo: {
        hasMore: false,
        limit: null,
        nextOffset: null,
        offset: 0,
      },
    });
    expect(listOwnerPostsForRoute).toHaveBeenCalledWith({
      userId: 'user-1',
      searchParams: new URL(request.url).searchParams,
    });
  });

  it('creates route handlers that forward GET and POST posts requests through the adapter', async () => {
    const posts = [{ id: 'post-1', visibility: 'public' }];
    const adminSupabase = { kind: 'admin' } as unknown as SupabaseClient;
    const createOwnerPostForRoute = vi.fn(async () => ({
      ok: true as const,
      body: {
        success: true as const,
        postId: 'post-2',
        visibility: 'private' as const,
        showcasePath: null,
        ownerPath: '/post/post-2/edit',
        resourceBundlePath: '/post/post-2/edit#recipe',
        resourceBundleStatus: null,
      },
    }));
    const listOwnerPostsForRoute = vi.fn(async () => ({
      ok: true as const,
      posts,
      pageInfo: {
        hasMore: false,
        limit: null,
        nextOffset: null,
        offset: 0,
      },
    }));
    const { GET, POST } = createPostsRouteHandlers({
      dependencies: {
        createOwnerPostForRoute,
        createServiceClient: vi.fn(() => adminSupabase),
        createUserClient: () => createUserClient('user-1'),
        listOwnerPostsForRoute,
      },
    });

    const getResponse = await GET(new Request('http://localhost/api/posts?scope=owner', {
      headers: { 'x-request-id': 'posts-factory-get-1' },
    }));
    const postResponse = await POST(new Request('http://localhost/api/posts', {
      method: 'POST',
      headers: { 'x-request-id': 'posts-factory-post-1' },
      body: new FormData(),
    }));

    expect(getResponse.status).toBe(200);
    expect(getResponse.headers.get('Cache-Control')).toBe('private, no-store');
    expect(getResponse.headers.get('x-request-id')).toBe('posts-factory-get-1');
    expect(postResponse.status).toBe(200);
    expect(postResponse.headers.get('Cache-Control')).toBe('private, no-store');
    expect(postResponse.headers.get('x-request-id')).toBe('posts-factory-post-1');
    await expect(getResponse.json()).resolves.toEqual({
      success: true,
      posts,
      pageInfo: {
        hasMore: false,
        limit: null,
        nextOffset: null,
        offset: 0,
      },
    });
    await expect(postResponse.json()).resolves.toEqual({
      success: true,
      postId: 'post-2',
      visibility: 'private',
      showcasePath: null,
      ownerPath: '/post/post-2/edit',
      resourceBundlePath: '/post/post-2/edit#recipe',
      resourceBundleStatus: null,
    });
    expect(listOwnerPostsForRoute).toHaveBeenCalledWith({
      userId: 'user-1',
      searchParams: new URL('http://localhost/api/posts?scope=owner').searchParams,
    });
    expect(createOwnerPostForRoute).toHaveBeenCalledWith({
      adminSupabase,
      ownerUserId: 'user-1',
      readFormData: expect.any(Function),
    });
  });

  it('maps owner post list failures to stable route errors', async () => {
    const response = await getPostsRouteResponse({
      request: new Request('http://localhost/api/posts?scope=public'),
      dependencies: {
        createUserClient: () => createUserClient('user-1'),
        listOwnerPostsForRoute: vi.fn(async () => ({
          ok: false as const,
          status: 400 as const,
          error: 'Unsupported posts scope.',
        })),
      },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Unsupported posts scope.' });
  });
});
