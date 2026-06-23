import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import {
  createPostResourceBundleRouteHandlers,
  getPostResourceBundleRouteResponse,
  putPostResourceBundleRouteResponse,
} from '@/lib/post-resource-bundle-route-adapter-service';

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

function createContext(postId = 'post-1') {
  return {
    params: Promise.resolve({ postId }),
  };
}

describe('post resource bundle route adapter service', () => {
  it('loads bundle details with optional viewer and country context and private headers', async () => {
    const getPostResourceBundleForRoute = vi.fn(async () => ({
      ok: true as const,
      body: {
        success: true,
        bundle: { id: 'bundle-1', accessMode: 'free' },
      },
    }));
    const createServiceClient = vi.fn();

    const response = await getPostResourceBundleRouteResponse({
      request: new Request('http://localhost/api/posts/post-1/resource-bundle', {
        headers: {
          'x-request-id': 'resource-bundle-detail-1',
          'x-vercel-ip-country': 'IN',
        },
      }),
      context: createContext(),
      dependencies: {
        createServiceClient,
        createUserClient: () => createUserClient('viewer-1'),
        getPostResourceBundleForRoute,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('resource-bundle-detail-1');
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      bundle: { id: 'bundle-1' },
    });
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(getPostResourceBundleForRoute).toHaveBeenCalledWith({
      postId: 'post-1',
      viewerUserId: 'viewer-1',
      countryCode: 'IN',
    });
  });

  it('rejects unauthenticated bundle saves before privileged work or body parsing', async () => {
    const request = new Request('http://localhost/api/posts/post-1/resource-bundle', {
      method: 'PUT',
      headers: { 'x-request-id': 'resource-bundle-auth-1' },
      body: JSON.stringify({ resourceBundle: null }),
    });
    const jsonSpy = vi.spyOn(request, 'json');
    const createServiceClient = vi.fn();
    const putPostResourceBundleForRoute = vi.fn();

    const response = await putPostResourceBundleRouteResponse({
      request,
      context: createContext(),
      dependencies: {
        createServiceClient,
        createUserClient: () => createUserClient(null),
        putPostResourceBundleForRoute,
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('resource-bundle-auth-1');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(putPostResourceBundleForRoute).not.toHaveBeenCalled();
  });

  it('maps rate-limit service results with standard headers', async () => {
    const rateLimitError = new BackendRateLimitError({
      allowed: false,
      limit: 60,
      remaining: 0,
      retryAfterSeconds: 30,
      resetAt: '2026-06-23T06:00:00.000Z',
    });
    const adminSupabase = { kind: 'admin' } as unknown as SupabaseClient;
    const userSupabase = createUserClient('user-1');
    const putPostResourceBundleForRoute = vi.fn(async () => ({
      ok: false as const,
      status: 429 as const,
      body: { error: 'Too many post updates.' },
      rateLimitError,
    }));

    const response = await putPostResourceBundleRouteResponse({
      request: new Request('http://localhost/api/posts/post-1/resource-bundle', {
        method: 'PUT',
        headers: { 'x-request-id': 'resource-bundle-limit-1' },
        body: JSON.stringify({ resourceBundle: null }),
      }),
      context: createContext(),
      dependencies: {
        createServiceClient: vi.fn(() => adminSupabase),
        createUserClient: () => userSupabase,
        putPostResourceBundleForRoute,
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('30');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('resource-bundle-limit-1');
    await expect(response.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 30,
      limit: 60,
    });
    expect(putPostResourceBundleForRoute).toHaveBeenCalledWith({
      postId: 'post-1',
      ownerUserId: 'user-1',
      userSupabase,
      adminSupabase,
      readBody: expect.any(Function),
    });
  });

  it('creates route handlers that forward GET and PUT requests through the adapter', async () => {
    const getPostResourceBundleForRoute = vi.fn(async () => ({
      ok: true as const,
      body: { success: true, bundle: { id: 'bundle-1' } },
    }));
    const putPostResourceBundleForRoute = vi.fn(async () => ({
      ok: true as const,
      body: { success: true, bundle: { id: 'bundle-1', accessMode: 'paid' } },
    }));
    const { GET, PUT } = createPostResourceBundleRouteHandlers({
      dependencies: {
        createServiceClient: vi.fn(() => ({ kind: 'admin' }) as unknown as SupabaseClient),
        createUserClient: () => createUserClient('owner-1'),
        getPostResourceBundleForRoute,
        putPostResourceBundleForRoute,
      },
    });

    const getResponse = await GET(
      new Request('http://localhost/api/posts/post-1/resource-bundle', {
        headers: { 'x-request-id': 'resource-bundle-factory-get-1' },
      }),
      createContext(),
    );
    const putResponse = await PUT(
      new Request('http://localhost/api/posts/post-1/resource-bundle', {
        method: 'PUT',
        headers: { 'x-request-id': 'resource-bundle-factory-put-1' },
        body: JSON.stringify({ resourceBundle: { accessMode: 'paid' } }),
      }),
      createContext(),
    );

    expect(getResponse.status).toBe(200);
    expect(getResponse.headers.get('x-request-id')).toBe('resource-bundle-factory-get-1');
    expect(putResponse.status).toBe(200);
    expect(putResponse.headers.get('x-request-id')).toBe('resource-bundle-factory-put-1');
    expect(getPostResourceBundleForRoute).toHaveBeenCalledWith(expect.objectContaining({
      postId: 'post-1',
      viewerUserId: 'owner-1',
    }));
    expect(putPostResourceBundleForRoute).toHaveBeenCalledWith(expect.objectContaining({
      postId: 'post-1',
      ownerUserId: 'owner-1',
    }));
  });
});
