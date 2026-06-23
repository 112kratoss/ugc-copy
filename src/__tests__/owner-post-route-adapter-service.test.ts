import { describe, expect, it, vi } from 'vitest';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import {
  createOwnerPostRouteHandlers,
  deleteOwnerPostRouteResponse,
  getOwnerPostRouteResponse,
  patchOwnerPostRouteResponse,
  putOwnerPostRouteResponse,
} from '@/lib/owner-post-route-adapter-service';

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
        post: {
          id: 'post-1',
          title: 'Draft post',
        },
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
      post: {
        id: 'post-1',
        title: 'Draft post',
      },
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
          body: { code: 'RATE_LIMITED' },
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
        success: true,
        postId: 'post-1',
        visibility: 'private',
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
        success: true,
        deleted: true,
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
      body: { success: true, method: 'GET', postId },
    }));
    const updateOwnerPostRoute = vi.fn(async ({ postId }) => ({
      ok: true as const,
      body: { success: true, method: 'MUTATE', postId },
    }));
    const deleteOwnerPostRoute = vi.fn(async ({ postId }) => ({
      ok: true as const,
      body: { success: true, method: 'DELETE', postId },
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
    await expect(getResponse.json()).resolves.toEqual({
      success: true,
      method: 'GET',
      postId: 'post-from-factory',
    });
    await expect(putResponse.json()).resolves.toEqual({
      success: true,
      method: 'MUTATE',
      postId: 'post-from-factory',
    });
    await expect(patchResponse.json()).resolves.toEqual({
      success: true,
      method: 'MUTATE',
      postId: 'post-from-factory',
    });
    await expect(deleteResponse.json()).resolves.toEqual({
      success: true,
      method: 'DELETE',
      postId: 'post-from-factory',
    });
    expect(getOwnerPostDetailForRoute).toHaveBeenCalledTimes(1);
    expect(updateOwnerPostRoute).toHaveBeenCalledTimes(2);
    expect(deleteOwnerPostRoute).toHaveBeenCalledTimes(1);
  });
});
