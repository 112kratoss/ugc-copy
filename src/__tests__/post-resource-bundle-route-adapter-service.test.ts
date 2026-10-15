import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import {
  createPostResourceBundleRouteHandlers,
  getPostResourceBundleRouteResponse,
} from '@/lib/post-resource-bundle-route-adapter-service';
import * as bundleRouteAdapter from '@/lib/post-resource-bundle-route-adapter-service';
import type { PostResourceBundleDetail } from '@/lib/post-resource-bundles-server';

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

function bundleDetail() {
  return {
    id: 'bundle-1',
    postId: 'post-1',
    seller: { id: 'creator-1' },
    viewerIsOwner: false,
  } as unknown as PostResourceBundleDetail;
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

    const response = await getPostResourceBundleRouteResponse({
      request: new Request('http://localhost/api/posts/post-1/resource-bundle', {
        headers: {
          'x-request-id': 'resource-bundle-detail-1',
          'x-vercel-ip-country': 'IN',
        },
      }),
      context: createContext(),
      dependencies: {
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
    expect(getPostResourceBundleForRoute).toHaveBeenCalledWith({
      postId: 'post-1',
      viewerUserId: 'viewer-1',
      countryCode: 'IN',
      getDetailByPostId: expect.any(Function),
    });
  });

  // The post page answers 404 across a block; this read, the app's Details
  // card and the unlock screen's fallback, still served the recipe (finding 02-3).
  it('answers not found when the viewer and the creator block each other', async () => {
    const getPostResourceBundleDetailByPostId = vi.fn(async () => bundleDetail());
    const isMarketplaceCreatorBlockedForViewer = vi.fn(async () => true);

    const response = await getPostResourceBundleRouteResponse({
      request: new Request('http://localhost/api/posts/post-1/resource-bundle', {
        headers: { 'x-request-id': 'resource-bundle-blocked-1', 'x-vercel-ip-country': 'IN' },
      }),
      context: createContext(),
      dependencies: {
        createUserClient: () => createUserClient('viewer-1'),
        getPostResourceBundleDetailByPostId,
        isMarketplaceCreatorBlockedForViewer,
      },
    });

    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({ error: 'Resource bundle not found.' });
    expect(getPostResourceBundleDetailByPostId).toHaveBeenCalledWith('post-1', {
      viewerUserId: 'viewer-1',
      countryCode: 'IN',
    });
    expect(isMarketplaceCreatorBlockedForViewer).toHaveBeenCalledWith('viewer-1', 'creator-1');
  });

  it('serves the bundle when no block stands, and asks a signed-out caller about none', async () => {
    const isMarketplaceCreatorBlockedForViewer = vi.fn(async () => false);

    const signedIn = await getPostResourceBundleRouteResponse({
      request: new Request('http://localhost/api/posts/post-1/resource-bundle'),
      context: createContext(),
      dependencies: {
        createUserClient: () => createUserClient('viewer-1'),
        getPostResourceBundleDetailByPostId: vi.fn(async () => bundleDetail()),
        isMarketplaceCreatorBlockedForViewer,
      },
    });
    expect(signedIn.status).toBe(200);
    await expect(signedIn.json()).resolves.toMatchObject({ success: true, bundle: { id: 'bundle-1' } });
    expect(isMarketplaceCreatorBlockedForViewer).toHaveBeenCalledTimes(1);

    const signedOut = await getPostResourceBundleRouteResponse({
      request: new Request('http://localhost/api/posts/post-1/resource-bundle'),
      context: createContext(),
      dependencies: {
        createUserClient: () => createUserClient(null),
        getPostResourceBundleDetailByPostId: vi.fn(async () => bundleDetail()),
        isMarketplaceCreatorBlockedForViewer,
      },
    });
    expect(signedOut.status).toBe(200);
    expect(isMarketplaceCreatorBlockedForViewer).toHaveBeenCalledTimes(1);
  });

  it('serves anonymous viewers without a session', async () => {
    const getPostResourceBundleForRoute = vi.fn(async () => ({
      ok: false as const,
      status: 404 as const,
      body: { error: 'Resource bundle not found.' },
    }));

    const response = await getPostResourceBundleRouteResponse({
      request: new Request('http://localhost/api/posts/post-1/resource-bundle'),
      context: createContext(),
      dependencies: {
        createUserClient: () => createUserClient(null),
        getPostResourceBundleForRoute,
      },
    });

    expect(response.status).toBe(404);
    expect(getPostResourceBundleForRoute).toHaveBeenCalledWith(expect.objectContaining({
      viewerUserId: null,
    }));
  });

  it('maps rate-limit service results with standard headers', async () => {
    const rateLimitError = new BackendRateLimitError({
      allowed: false,
      limit: 60,
      remaining: 0,
      retryAfterSeconds: 30,
      resetAt: '2026-06-23T06:00:00.000Z',
    });
    const getPostResourceBundleForRoute = vi.fn(async () => ({
      ok: false as const,
      status: 429 as const,
      body: { error: 'Too many requests.' },
      rateLimitError,
    }));

    const response = await getPostResourceBundleRouteResponse({
      request: new Request('http://localhost/api/posts/post-1/resource-bundle', {
        headers: { 'x-request-id': 'resource-bundle-limit-1' },
      }),
      context: createContext(),
      dependencies: {
        createUserClient: () => createUserClient('user-1'),
        getPostResourceBundleForRoute,
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
  });

  it('creates route handlers that forward GET requests through the adapter', async () => {
    const getPostResourceBundleForRoute = vi.fn(async () => ({
      ok: true as const,
      body: { success: true, bundle: { id: 'bundle-1' } },
    }));
    const handlers = createPostResourceBundleRouteHandlers({
      dependencies: {
        createUserClient: () => createUserClient('owner-1'),
        getPostResourceBundleForRoute,
      },
    });

    const getResponse = await handlers.GET(
      new Request('http://localhost/api/posts/post-1/resource-bundle', {
        headers: { 'x-request-id': 'resource-bundle-factory-get-1' },
      }),
      createContext(),
    );

    expect(getResponse.status).toBe(200);
    expect(getResponse.headers.get('x-request-id')).toBe('resource-bundle-factory-get-1');
    expect(getPostResourceBundleForRoute).toHaveBeenCalledWith(expect.objectContaining({
      postId: 'post-1',
      viewerUserId: 'owner-1',
    }));
  });

  // The bundle write endpoint was removed: it validated media scope without the
  // post's media keys and skipped the moderation lock the post update path has.
  // Bundle writes belong to POST /api/posts and PATCH /api/posts/[postId].
  it('exposes no bundle write surface', () => {
    const handlers = createPostResourceBundleRouteHandlers({
      dependencies: { createUserClient: () => createUserClient('owner-1') },
    });

    expect(Object.keys(handlers)).toEqual(['GET']);
    expect('putPostResourceBundleRouteResponse' in bundleRouteAdapter).toBe(false);
  });
});
