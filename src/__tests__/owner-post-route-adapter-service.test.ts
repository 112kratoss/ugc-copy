import { describe, expect, it, vi } from 'vitest';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import {
  createOwnerPostRouteHandlers,
  deleteOwnerPostRouteResponse,
  getOwnerPostRouteResponse,
  patchOwnerPostRouteResponse,
  putOwnerPostRouteResponse,
} from '@/lib/owner-post-route-adapter-service';
import type { OwnerPostDetail } from '@/lib/owner-posts';

const ownerPostFixture = {
  id: 'post-1',
  generationId: null,
  visibility: 'private',
  archivedAt: null,
  mediaUrl: null,
  mediaKind: null,
  mediaItems: [],
  title: 'Draft post',
  rawTitle: 'Draft post',
  description: '',
  prompt: '',
  body: '',
  category: 'image',
  postFormat: 'text',
  sourceKind: 'external',
  sourceTool: null,
  sourceToolSlug: null,
  sourceLabel: 'Uploaded',
  commentCount: 0,
  createdAt: '2026-06-23T10:00:00.000Z',
  updatedAt: '2026-06-23T10:00:00.000Z',
  publicPath: null,
  ownerPath: '/post/post-1/edit',
  resourcePath: null,
  canShare: false,
  bundle: null,
  resourceBundleInput: { accessMode: 'none' },
  hasPaidOrders: false,
} satisfies OwnerPostDetail;

function createContext(postId = 'post-1') {
  return {
    params: Promise.resolve({ postId }),
  };
}

function createRequest(method = 'GET', headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/posts/post-1', {
    method,
    headers,
    body: method === 'GET' ? undefined : JSON.stringify({ title: 'Updated post' }),
  });
}

describe('owner post route adapter service', () => {
  it('loads owner post detail by post id and applies private no-store headers', async () => {
    const getOwnerPostDetailForRoute = vi.fn(async () => ({
      ok: true as const,
      body: {
        success: true as const,
        post: ownerPostFixture,
      },
    }));
    const request = createRequest('GET', { 'x-request-id': 'owner-post-get-1' });

    const response = await getOwnerPostRouteResponse({
      request,
      context: createContext(),
      dependencies: {
        getOwnerPostDetailForRoute,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('owner-post-get-1');
    await expect(response.json()).resolves.toEqual({
      success: true,
      post: ownerPostFixture,
    });
    expect(getOwnerPostDetailForRoute).toHaveBeenCalledWith({ request, postId: 'post-1' });
  });

  it('maps owner post detail misses to stable private 404 responses', async () => {
    const response = await getOwnerPostRouteResponse({
      request: createRequest('GET', { 'x-request-id': 'owner-post-missing-1' }),
      context: createContext('missing'),
      dependencies: {
        getOwnerPostDetailForRoute: vi.fn(async () => ({
          ok: false as const,
          status: 404 as const,
          body: { error: 'Post not found.' },
        })),
      },
    });

    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('owner-post-missing-1');
    await expect(response.json()).resolves.toEqual({ error: 'Post not found.' });
  });

  it('maps owner post mutation rate limits to standard private responses', async () => {
    const rateLimitError = new BackendRateLimitError({
      allowed: false,
      limit: 60,
      remaining: 0,
      retryAfterSeconds: 29,
      resetAt: '2026-06-23T14:00:00.000Z',
    });
    const request = createRequest('PUT', {
      'Content-Type': 'application/json',
      'x-request-id': 'owner-post-put-limit-1',
    });

    const response = await putOwnerPostRouteResponse({
      request,
      context: createContext(),
      dependencies: {
        updateOwnerPostRoute: vi.fn(async () => ({
          ok: false as const,
          status: 429 as const,
          body: {
            error: rateLimitError.message,
            code: 'RATE_LIMITED' as const,
            retryAfterSeconds: 29,
            limit: 60,
            resetAt: '2026-06-23T14:00:00.000Z',
          },
          rateLimitError,
        })),
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('29');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('owner-post-put-limit-1');
    await expect(response.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 29,
      limit: 60,
    });
  });

  it('routes PATCH through the owner post update service', async () => {
    const updateOwnerPostRoute = vi.fn(async () => ({
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
    const request = createRequest('PATCH', {
      'Content-Type': 'application/json',
      'x-request-id': 'owner-post-patch-1',
    });

    const response = await patchOwnerPostRouteResponse({
      request,
      context: createContext(),
      dependencies: {
        updateOwnerPostRoute,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      postId: 'post-1',
    });
    expect(updateOwnerPostRoute).toHaveBeenCalledWith({ request, postId: 'post-1' });
  });

  it('routes DELETE through the owner post delete service', async () => {
    const deleteOwnerPostRoute = vi.fn(async () => ({
      ok: true as const,
      body: {
        success: true as const,
        deleted: true as const,
      },
    }));
    const request = createRequest('DELETE', { 'x-request-id': 'owner-post-delete-1' });

    const response = await deleteOwnerPostRouteResponse({
      request,
      context: createContext(),
      dependencies: {
        deleteOwnerPostRoute,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('owner-post-delete-1');
    await expect(response.json()).resolves.toEqual({
      success: true,
      deleted: true,
    });
    expect(deleteOwnerPostRoute).toHaveBeenCalledWith({ request, postId: 'post-1' });
  });

  it('creates compact handlers for the owner post route entrypoint', async () => {
    const getOwnerPostDetailForRoute = vi.fn(async ({ postId }) => ({
      ok: true as const,
      body: {
        success: true as const,
        method: 'GET',
        postId,
        post: { ...ownerPostFixture, id: postId },
      },
    }));
    const updateOwnerPostRoute = vi.fn(async ({ postId }) => ({
      ok: true as const,
      body: {
        success: true as const,
        method: 'MUTATE',
        postId,
        visibility: 'private' as const,
        showcasePath: null,
        ownerPath: `/post/${postId}/edit`,
        resourceBundlePath: `/post/${postId}/edit#recipe`,
        resourceBundleStatus: null,
      },
    }));
    const deleteOwnerPostRoute = vi.fn(async ({ postId }) => ({
      ok: true as const,
      body: {
        success: true as const,
        deleted: true as const,
        method: 'DELETE',
        postId,
      },
    }));
    const { DELETE, GET, PATCH, PUT } = createOwnerPostRouteHandlers({
      dependencies: {
        deleteOwnerPostRoute,
        getOwnerPostDetailForRoute,
        updateOwnerPostRoute,
      },
    });
    const context = createContext('post-from-factory');

    const getResponse = await GET(
      createRequest('GET', { 'x-request-id': 'owner-post-factory-get' }),
      context,
    );
    const putResponse = await PUT(createRequest('PUT'), context);
    const patchResponse = await PATCH(createRequest('PATCH'), context);
    const deleteResponse = await DELETE(createRequest('DELETE'), context);

    expect(getResponse.headers.get('Cache-Control')).toBe('private, no-store');
    expect(getResponse.headers.get('x-request-id')).toBe('owner-post-factory-get');
    await expect(getResponse.json()).resolves.toMatchObject({
      success: true,
      method: 'GET',
      postId: 'post-from-factory',
    });
    await expect(putResponse.json()).resolves.toMatchObject({
      success: true,
      method: 'MUTATE',
      postId: 'post-from-factory',
    });
    await expect(patchResponse.json()).resolves.toMatchObject({
      success: true,
      method: 'MUTATE',
      postId: 'post-from-factory',
    });
    await expect(deleteResponse.json()).resolves.toMatchObject({
      success: true,
      method: 'DELETE',
      postId: 'post-from-factory',
    });
    expect(getOwnerPostDetailForRoute).toHaveBeenCalledTimes(1);
    expect(updateOwnerPostRoute).toHaveBeenCalledTimes(2);
    expect(deleteOwnerPostRoute).toHaveBeenCalledTimes(1);
  });

  describe('deferred media repair', () => {
    const savedEdit = {
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
    };

    it('leaves a saved edit for the leased repair worker', async () => {
      const adminSupabase = { kind: 'admin' };
      const repairMediaForPost = vi.fn(async () => ({ attempted: 1, completed: 1, failed: 0 }));
      const createServiceClient = vi.fn(() => adminSupabase);
      const scheduled: Array<() => Promise<void>> = [];

      const response = await putOwnerPostRouteResponse({
        request: createRequest('PUT'),
        context: createContext(),
        dependencies: {
          updateOwnerPostRoute: vi.fn(async () => savedEdit),
          createServiceClient: createServiceClient as never,
          repairMediaForPost: repairMediaForPost as never,
          schedulePostMediaRepair: (callback) => { scheduled.push(callback); },
        },
      });

      expect(response.status).toBe(200);
      // Scheduled, not awaited: the edit response must not wait on a transcode,
      // and no admin client is built until the repair actually runs.
      expect(repairMediaForPost).not.toHaveBeenCalled();
      expect(createServiceClient).not.toHaveBeenCalled();
      expect(scheduled).toHaveLength(0);
    });

    it('does not schedule a repair when the edit was rejected', async () => {
      const scheduled: Array<() => Promise<void>> = [];

      const response = await putOwnerPostRouteResponse({
        request: createRequest('PUT'),
        context: createContext(),
        dependencies: {
          updateOwnerPostRoute: vi.fn(async () => ({
            ok: false as const,
            status: 400 as const,
            body: { error: 'Titles are limited to 120 characters.' },
          })),
          schedulePostMediaRepair: (callback) => { scheduled.push(callback); },
        },
      });

      expect(response.status).toBe(400);
      expect(scheduled).toEqual([]);
    });

    it('keeps a failing repair from surfacing after the edit is saved', async () => {
      const scheduled: Array<() => Promise<void>> = [];

      const response = await putOwnerPostRouteResponse({
        request: createRequest('PUT'),
        context: createContext(),
        dependencies: {
          updateOwnerPostRoute: vi.fn(async () => savedEdit),
          createServiceClient: (() => ({})) as never,
          repairMediaForPost: (async () => { throw new Error('ffmpeg exited with code 1'); }) as never,
          schedulePostMediaRepair: (callback) => { scheduled.push(callback); },
        },
      });

      expect(response.status).toBe(200);
      expect(scheduled).toHaveLength(0);
    });

    it('still saves the edit when the repair cannot be scheduled', async () => {
      // `after()` throws outside a request scope; an edit that already
      // succeeded must not be reported as a failure because of it.
      const response = await putOwnerPostRouteResponse({
        request: createRequest('PUT'),
        context: createContext(),
        dependencies: {
          updateOwnerPostRoute: vi.fn(async () => savedEdit),
          schedulePostMediaRepair: () => { throw new Error('after() outside a request scope'); },
        },
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ postId: 'post-1' });
    });
  });
});
