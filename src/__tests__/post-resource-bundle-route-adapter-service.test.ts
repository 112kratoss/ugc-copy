import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import {
  createPostResourceBundleRouteHandlers,
  getPostResourceBundleRouteResponse,
} from '@/lib/post-resource-bundle-route-adapter-service';
import * as bundleRouteAdapter from '@/lib/post-resource-bundle-route-adapter-service';
import type { PostResourceBundleDetail } from '@/lib/post-resource-bundles-server';
import { postRecipeReadPath } from '@/lib/post-recipe-read';

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
  it("loads a signed-in viewer's bundle with their country, and never lets it be stored", async () => {
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
          Authorization: 'Bearer viewer-token',
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
        headers: {
          Authorization: 'Bearer viewer-token',
          'x-request-id': 'resource-bundle-blocked-1',
          'x-vercel-ip-country': 'IN',
        },
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
      request: new Request('http://localhost/api/posts/post-1/resource-bundle', {
        headers: { Authorization: 'Bearer viewer-token' },
      }),
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
    // A recipe missing now may be listed in a minute: only a found one is kept.
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(getPostResourceBundleForRoute).toHaveBeenCalledWith(expect.objectContaining({
      viewerUserId: null,
    }));
  });

  // The post page asks this for every visitor who opens a cash-priced recipe,
  // to price it in their currency. A visitor's answer is everyone's in their
  // country, so the edge keeps one per country, as it does the listing's.
  it("lets the edge keep a visitor's answer per country, read without asking who they are", async () => {
    const createUserClientForTest = vi.fn(() => createUserClient('viewer-1'));
    const getPostResourceBundleForRoute = vi.fn(async () => ({
      ok: true as const,
      body: { success: true, bundle: { id: 'bundle-1', accessMode: 'paid' } },
    }));

    const response = await getPostResourceBundleRouteResponse({
      request: new Request('http://localhost/api/posts/post-1/resource-bundle', {
        headers: { 'x-request-id': 'resource-bundle-visitor-1', 'x-vercel-ip-country': 'IN' },
      }),
      context: createContext(),
      dependencies: {
        createUserClient: createUserClientForTest,
        getPostResourceBundleForRoute,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, s-maxage=60, stale-while-revalidate=300');
    expect(response.headers.get('Vary')).toBe('Authorization, x-vercel-ip-country');
    expect(response.headers.get('x-request-id')).toBe('resource-bundle-visitor-1');
    // No bearer, no viewer: a cookie or anything else in the request is never read.
    expect(createUserClientForTest).not.toHaveBeenCalled();
    expect(getPostResourceBundleForRoute).toHaveBeenCalledWith({
      postId: 'post-1',
      viewerUserId: null,
      countryCode: 'IN',
      getDetailByPostId: expect.any(Function),
    });
  });

  it("never lets an answer read with a bearer be stored, whoever it turned out to be", async () => {
    const getPostResourceBundleForRoute = vi.fn(async () => ({
      ok: true as const,
      body: { success: true, bundle: { id: 'bundle-1', accessMode: 'paid' } },
    }));

    for (const userId of ['buyer-1', null]) {
      const response = await getPostResourceBundleRouteResponse({
        request: new Request('http://localhost/api/posts/post-1/resource-bundle', {
          headers: { Authorization: 'Bearer some-token', 'x-vercel-ip-country': 'IN' },
        }),
        context: createContext(),
        dependencies: {
          createUserClient: () => createUserClient(userId),
          getPostResourceBundleForRoute,
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
      expect(response.headers.get('Vary')).toBe('Authorization, x-vercel-ip-country');
    }
  });

  // Sweep of 2026-11-17: the post page asks this on every post a signed-in reader opens, and each
  // post with no recipe for them logged the 404 as a failed load. The page asks with absent=none.
  describe('asked to answer an absent recipe as none', () => {
    const notFound = () => vi.fn(async () => ({
      ok: false as const,
      status: 404 as const,
      body: { error: 'Resource bundle not found.' },
    }));

    it('answers a recipe that is not there for the viewer as none, never kept anywhere', async () => {
      for (const authorization of ['Bearer viewer-token', null]) {
        const response = await getPostResourceBundleRouteResponse({
          request: new Request(`http://localhost${postRecipeReadPath('post-1')}`, {
            headers: authorization ? { Authorization: authorization, 'x-vercel-ip-country': 'IN' } : { 'x-vercel-ip-country': 'IN' },
          }),
          context: createContext(),
          dependencies: {
            createUserClient: () => createUserClient('viewer-1'),
            getPostResourceBundleForRoute: notFound(),
          },
        });

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ success: true, bundle: null });
        // A recipe missing now may be listed in a minute, for a visitor too: only a found one is kept.
        expect(response.headers.get('Cache-Control')).toBe('private, no-store');
        expect(response.headers.get('Vary')).toBe('Authorization, x-vercel-ip-country');
      }
    });

    it('answers across a block as none too', async () => {
      const response = await getPostResourceBundleRouteResponse({
        request: new Request(`http://localhost${postRecipeReadPath('post-1')}`, {
          headers: { Authorization: 'Bearer viewer-token' },
        }),
        context: createContext(),
        dependencies: {
          createUserClient: () => createUserClient('viewer-1'),
          getPostResourceBundleDetailByPostId: vi.fn(async () => bundleDetail()),
          isMarketplaceCreatorBlockedForViewer: vi.fn(async () => true),
        },
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ success: true, bundle: null });
    });

    it('answers a recipe that is there as it always does', async () => {
      const response = await getPostResourceBundleRouteResponse({
        request: new Request(`http://localhost${postRecipeReadPath('post-1')}`, {
          headers: { 'x-vercel-ip-country': 'IN' },
        }),
        context: createContext(),
        dependencies: {
          createUserClient: () => createUserClient(null),
          getPostResourceBundleForRoute: vi.fn(async () => ({
            ok: true as const,
            body: { success: true, bundle: { id: 'bundle-1', accessMode: 'paid' } },
          })),
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('public, s-maxage=60, stale-while-revalidate=300');
      await expect(response.json()).resolves.toMatchObject({ success: true, bundle: { id: 'bundle-1' } });
    });

    // The app's Details, the reel, the recipe panel and checkout read a 404 as "not found".
    it('keeps the 404 for every caller that does not ask, and for any other value', async () => {
      for (const path of ['/api/posts/post-1/resource-bundle', '/api/posts/post-1/resource-bundle?absent=null']) {
        const response = await getPostResourceBundleRouteResponse({
          request: new Request(`http://localhost${path}`, { headers: { Authorization: 'Bearer viewer-token' } }),
          context: createContext(),
          dependencies: {
            createUserClient: () => createUserClient('viewer-1'),
            getPostResourceBundleForRoute: notFound(),
          },
        });

        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toEqual({ error: 'Resource bundle not found.' });
      }
    });

    it('still answers a limit or a failure as one', async () => {
      const response = await getPostResourceBundleRouteResponse({
        request: new Request(`http://localhost${postRecipeReadPath('post-1')}`),
        context: createContext(),
        dependencies: {
          createUserClient: () => createUserClient(null),
          getPostResourceBundleForRoute: vi.fn(async () => ({
            ok: false as const,
            status: 500 as const,
            body: { error: 'Failed to load resource bundle.' },
          })),
        },
      });

      expect(response.status).toBe(500);
    });
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
        headers: { Authorization: 'Bearer owner-token', 'x-request-id': 'resource-bundle-factory-get-1' },
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
