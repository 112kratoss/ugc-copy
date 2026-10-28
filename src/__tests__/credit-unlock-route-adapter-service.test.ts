import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { BackendRateLimitError, CREDIT_UNLOCK_RATE_LIMIT } from '@/lib/backend-rate-limit';
import {
  postMarketplaceCreditUnlockRouteResponse,
  postResourceBundleCreditUnlockRouteResponse,
} from '@/lib/credit-unlock-route-adapter-service';
import { isPostResourceBundleBuyWithheld } from '@/lib/marketplace-viewer-filter';
import { MobileCommerceError } from '@/lib/mobile-commerce';
import type { PostResourceBundleDetail } from '@/lib/post-resource-bundles-server';

function createMarketplaceContext(assetId = 'asset-1') {
  return {
    params: Promise.resolve({ assetId }),
  };
}

function createPostContext(postId = 'post-1') {
  return {
    params: Promise.resolve({ postId }),
  };
}

function createUserClient(userId: string | null = 'buyer-1') {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: userId ? { id: userId } : null },
        error: userId ? null : new Error('missing session'),
      })),
    },
  } as unknown as SupabaseClient;
}

const allowedRateLimit = vi.fn(async () => ({
  allowed: true,
  limit: 20,
  remaining: 19,
  retryAfterSeconds: 0,
  resetAt: '2026-06-23T08:30:00.000Z',
}));

// The real buy gate over a detail read that shows (or withholds) the bundle and
// a block check that finds (or does not find) one between buyer and creator.
function buyGate({ readShowsBundle = true, blocked = false } = {}) {
  return ((input) => isPostResourceBundleBuyWithheld(input, {
    getPostResourceBundleDetailByPostId: vi.fn(async () => (readShowsBundle
      ? { id: 'bundle-1', seller: { id: 'creator-1' }, viewerIsOwner: false } as unknown as PostResourceBundleDetail
      : null)),
    isUserRelationshipBlocked: vi.fn(async () => blocked),
  })) as typeof isPostResourceBundleBuyWithheld;
}

function createRequest(url = 'http://localhost/api/marketplace/assets/asset-1/unlock-with-credits') {
  return new Request(url, {
    method: 'POST',
    headers: {
      authorization: 'Bearer private-token',
      'x-request-id': 'credit-unlock-1',
    },
  });
}

describe('credit unlock route adapter service', () => {
  it('rejects unauthenticated marketplace credit unlocks before privileged work', async () => {
    const createServiceClient = vi.fn();
    const enforceBackendRateLimit = vi.fn();
    const unlockMarketplaceAssetWithCredits = vi.fn();

    const response = await postMarketplaceCreditUnlockRouteResponse({
      request: createRequest(),
      context: createMarketplaceContext(),
      dependencies: {
        createServiceClient,
        createUserClient: () => createUserClient(null),
        enforceBackendRateLimit,
        unlockMarketplaceAssetWithCredits,
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('credit-unlock-1');
    expect(response.headers.has('authorization')).toBe(false);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(enforceBackendRateLimit).not.toHaveBeenCalled();
    expect(unlockMarketplaceAssetWithCredits).not.toHaveBeenCalled();
  });

  it('maps post resource credit unlock rate limits with standard backend headers', async () => {
    const adminSupabase = { service: 'admin' } as unknown as SupabaseClient;
    const rateLimitError = new BackendRateLimitError({
      allowed: false,
      limit: 20,
      remaining: 0,
      retryAfterSeconds: 41,
      resetAt: '2026-06-23T08:30:00.000Z',
    });
    const enforceBackendRateLimit = vi.fn(async () => {
      throw rateLimitError;
    });
    const unlockPostResourceBundleWithCredits = vi.fn();
    const isWithheld = vi.fn();

    const response = await postResourceBundleCreditUnlockRouteResponse({
      request: createRequest('http://localhost/api/posts/post-1/resource-bundle/unlock-with-credits'),
      context: createPostContext(),
      dependencies: {
        createServiceClient: vi.fn(() => adminSupabase),
        createUserClient: () => createUserClient('buyer-1'),
        enforceBackendRateLimit,
        isPostResourceBundleBuyWithheld: isWithheld,
        unlockPostResourceBundleWithCredits,
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('41');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 41,
      limit: 20,
    });
    expect(enforceBackendRateLimit).toHaveBeenCalledWith(adminSupabase, {
      ...CREDIT_UNLOCK_RATE_LIMIT,
      key: 'buyer-1',
    });
    expect(isWithheld).not.toHaveBeenCalled();
    expect(unlockPostResourceBundleWithCredits).not.toHaveBeenCalled();
  });

  it('delegates successful marketplace credit unlocks after rate limiting', async () => {
    const adminSupabase = { service: 'admin' } as unknown as SupabaseClient;
    const unlockMarketplaceAssetWithCredits = vi.fn(async () => ({
      success: true as const,
      entitlement: 'marketplace_unlock' as const,
      assetId: 'asset-1',
      credits: 18,
      alreadyProcessed: false,
    }));

    const response = await postMarketplaceCreditUnlockRouteResponse({
      request: createRequest(),
      context: createMarketplaceContext(),
      dependencies: {
        createServiceClient: vi.fn(() => adminSupabase),
        createUserClient: () => createUserClient('buyer-1'),
        enforceBackendRateLimit: vi.fn(async () => ({
          allowed: true,
          limit: 20,
          remaining: 19,
          retryAfterSeconds: 0,
          resetAt: '2026-06-23T08:30:00.000Z',
        })),
        unlockMarketplaceAssetWithCredits,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      entitlement: 'marketplace_unlock',
      assetId: 'asset-1',
    });
    expect(unlockMarketplaceAssetWithCredits).toHaveBeenCalledWith({
      adminSupabase,
      userId: 'buyer-1',
      assetId: 'asset-1',
      runAfterResponse: expect.any(Function),
    });
  });

  it('gives the marketplace credit unlock a way to send its notifications after the response', async () => {
    const notify = vi.fn(async () => null);
    const scheduled: Array<() => Promise<unknown>> = [];
    const unlockMarketplaceAssetWithCredits = vi.fn(
      async ({ runAfterResponse }: { runAfterResponse?: (task: () => Promise<unknown>) => void }) => {
        runAfterResponse?.(notify);
        return {
          success: true as const,
          entitlement: 'marketplace_unlock' as const,
          assetId: 'asset-1',
          credits: 18,
          alreadyProcessed: false,
        };
      },
    );

    const response = await postMarketplaceCreditUnlockRouteResponse({
      request: createRequest(),
      context: createMarketplaceContext(),
      dependencies: {
        createServiceClient: vi.fn(() => ({ service: 'admin' }) as unknown as SupabaseClient),
        createUserClient: () => createUserClient('buyer-1'),
        enforceBackendRateLimit: vi.fn(async () => ({
          allowed: true,
          limit: 20,
          remaining: 19,
          retryAfterSeconds: 0,
          resetAt: '2026-06-23T08:30:00.000Z',
        })),
        runAfterResponse: (task) => { scheduled.push(task); },
        unlockMarketplaceAssetWithCredits,
      },
    });

    // The response is ready while the notification is only queued.
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      entitlement: 'marketplace_unlock',
      assetId: 'asset-1',
      credits: 18,
      alreadyProcessed: false,
    });
    expect(scheduled).toHaveLength(1);
    expect(notify).not.toHaveBeenCalled();

    await scheduled[0]();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('delegates successful post resource credit unlocks after rate limiting', async () => {
    const adminSupabase = { service: 'admin' } as unknown as SupabaseClient;
    const unlockPostResourceBundleWithCredits = vi.fn(async () => ({
      success: true as const,
      entitlement: 'post_resource_unlock' as const,
      postId: 'post-1',
      credits: 12,
      alreadyProcessed: false,
    }));
    const isWithheld = vi.fn(async () => false);

    const response = await postResourceBundleCreditUnlockRouteResponse({
      request: createRequest('http://localhost/api/posts/post-1/resource-bundle/unlock-with-credits'),
      context: createPostContext(),
      dependencies: {
        createServiceClient: vi.fn(() => adminSupabase),
        createUserClient: () => createUserClient('buyer-1'),
        enforceBackendRateLimit: vi.fn(async () => ({
          allowed: true,
          limit: 20,
          remaining: 19,
          retryAfterSeconds: 0,
          resetAt: '2026-06-23T08:30:00.000Z',
        })),
        isPostResourceBundleBuyWithheld: isWithheld,
        unlockPostResourceBundleWithCredits,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      entitlement: 'post_resource_unlock',
      postId: 'post-1',
    });
    expect(unlockPostResourceBundleWithCredits).toHaveBeenCalledWith({
      adminSupabase,
      userId: 'buyer-1',
      postId: 'post-1',
      runAfterResponse: expect.any(Function),
    });
    expect(isWithheld).toHaveBeenCalledWith({ adminSupabase, buyerUserId: 'buyer-1', postId: 'post-1' });
  });

  // The spend RPC checks only the bundle's status, so a direct call could buy
  // from (and notify) a creator who blocked the buyer, or buy what the read
  // refuses (2026-10-15 marketplace comparison, finding 02-3).
  it.each([
    ['the buyer and the creator block each other', { blocked: true }],
    ['the detail read withholds the bundle (a take-down, an unrevealed mature post)', { readShowsBundle: false }],
  ])('answers not found when %s, with nothing spent or notified', async (_reason, gate) => {
    const unlockPostResourceBundleWithCredits = vi.fn();
    const scheduled: Array<() => Promise<unknown>> = [];

    const response = await postResourceBundleCreditUnlockRouteResponse({
      request: createRequest('http://localhost/api/posts/post-1/resource-bundle/unlock-with-credits'),
      context: createPostContext(),
      dependencies: {
        createServiceClient: vi.fn(() => ({ service: 'admin' }) as unknown as SupabaseClient),
        createUserClient: () => createUserClient('buyer-1'),
        enforceBackendRateLimit: allowedRateLimit,
        isPostResourceBundleBuyWithheld: buyGate(gate),
        runAfterResponse: (task) => { scheduled.push(task); },
        unlockPostResourceBundleWithCredits,
      },
    });

    // The same answer the spend RPC gives an unlock that does not exist.
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({ error: 'Post unlock not found.' });
    expect(unlockPostResourceBundleWithCredits).not.toHaveBeenCalled();
    expect(scheduled).toEqual([]);
  });

  // Welcome and referral credits count in the total but cannot buy a recipe;
  // the 402 says what was spendable so the client can show the shortfall.
  it('answers a refused spend with the fields the refusal carries', async () => {
    const response = await postResourceBundleCreditUnlockRouteResponse({
      request: createRequest('http://localhost/api/posts/post-1/resource-bundle/unlock-with-credits'),
      context: createPostContext(),
      dependencies: {
        createServiceClient: vi.fn(() => ({ service: 'admin' }) as unknown as SupabaseClient),
        createUserClient: () => createUserClient('buyer-1'),
        enforceBackendRateLimit: allowedRateLimit,
        isPostResourceBundleBuyWithheld: vi.fn(async () => false),
        unlockPostResourceBundleWithCredits: vi.fn(async () => {
          throw new MobileCommerceError(
            'Insufficient credits. This unlock costs 900 credits.',
            402,
            'insufficient_credits',
            {
              code: 'INSUFFICIENT_CREDITS',
              creditCost: 900,
              remainingCredits: 1200,
              marketplaceSpendableCredits: 0,
            },
          );
        }),
      },
    });

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toEqual({
      error: 'Insufficient credits. This unlock costs 900 credits.',
      code: 'INSUFFICIENT_CREDITS',
      creditCost: 900,
      remainingCredits: 1200,
      marketplaceSpendableCredits: 0,
    });
  });

  // Recipe audit H4 (2026-10-27): the clients send the price the buyer
  // confirmed, and a changed price is refused with the new one. An app build
  // from before the check sends no body at all and is answered as before.
  describe('the confirmed price', () => {
    function postRequest(body?: string) {
      return new Request('http://localhost/api/posts/post-1/resource-bundle/unlock-with-credits', {
        method: 'POST',
        headers: {
          authorization: 'Bearer private-token',
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body }),
      });
    }

    function dependenciesWith(unlockPostResourceBundleWithCredits: ReturnType<typeof vi.fn>) {
      return {
        createServiceClient: vi.fn(() => ({ service: 'admin' }) as unknown as SupabaseClient),
        createUserClient: () => createUserClient('buyer-1'),
        enforceBackendRateLimit: allowedRateLimit,
        isPostResourceBundleBuyWithheld: vi.fn(async () => false),
        runAfterResponse: vi.fn(),
        unlockPostResourceBundleWithCredits,
      } as never;
    }

    const settled = async () => ({
      success: true as const,
      entitlement: 'post_resource_unlock' as const,
      postId: 'post-1',
      credits: 100,
      alreadyProcessed: false,
    });

    it('passes the confirmed price to the spend', async () => {
      const unlock = vi.fn(settled);

      const response = await postResourceBundleCreditUnlockRouteResponse({
        request: postRequest(JSON.stringify({ expectedPriceCredits: 900 })),
        context: createPostContext(),
        dependencies: dependenciesWith(unlock),
      });

      expect(response.status).toBe(200);
      expect(unlock).toHaveBeenCalledWith(expect.objectContaining({ postId: 'post-1', expectedPriceCredits: 900 }));
    });

    it.each([
      ['no body', undefined],
      ['an empty body', ''],
      ['an object without a price', '{}'],
      ['a null price', '{"expectedPriceCredits":null}'],
    ])('spends at the current price for %s', async (_label, body) => {
      const unlock = vi.fn(settled);

      const response = await postResourceBundleCreditUnlockRouteResponse({
        request: postRequest(body),
        context: createPostContext(),
        dependencies: dependenciesWith(unlock),
      });

      expect(response.status).toBe(200);
      expect(unlock).toHaveBeenCalledWith(expect.not.objectContaining({ expectedPriceCredits: expect.anything() }));
    });

    it.each([
      ['a body that is not JSON', 'price=900'],
      ['a price that is not a whole number of credits', '{"expectedPriceCredits":9.5}'],
      ['a negative price', '{"expectedPriceCredits":-10}'],
      ['a price sent as text', '{"expectedPriceCredits":"900"}'],
    ])('refuses %s and spends nothing', async (_label, body) => {
      const unlock = vi.fn(settled);

      const response = await postResourceBundleCreditUnlockRouteResponse({
        request: postRequest(body),
        context: createPostContext(),
        dependencies: dependenciesWith(unlock),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: 'expectedPriceCredits must be a whole number of credits.',
      });
      expect(unlock).not.toHaveBeenCalled();
    });

    it('answers a changed price with 409 and the new price', async () => {
      const unlock = vi.fn(async () => {
        throw new MobileCommerceError('The price changed to 1,500 credits.', 409, 'price_changed', {
          success: false,
          code: 'RESOURCE_PRICE_CHANGED',
          priceCredits: 1500,
        });
      });

      const response = await postResourceBundleCreditUnlockRouteResponse({
        request: postRequest(JSON.stringify({ expectedPriceCredits: 100 })),
        context: createPostContext(),
        dependencies: dependenciesWith(unlock),
      });

      expect(response.status).toBe(409);
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
      await expect(response.json()).resolves.toEqual({
        success: false,
        code: 'RESOURCE_PRICE_CHANGED',
        error: 'The price changed to 1,500 credits.',
        priceCredits: 1500,
      });
    });
  });

  it('spends nothing when the gate cannot be checked', async () => {
    const logError = vi.fn();
    const unlockPostResourceBundleWithCredits = vi.fn();

    const response = await postResourceBundleCreditUnlockRouteResponse({
      request: createRequest('http://localhost/api/posts/post-1/resource-bundle/unlock-with-credits'),
      context: createPostContext(),
      dependencies: {
        createServiceClient: vi.fn(() => ({ service: 'admin' }) as unknown as SupabaseClient),
        createUserClient: () => createUserClient('buyer-1'),
        enforceBackendRateLimit: allowedRateLimit,
        isPostResourceBundleBuyWithheld: vi.fn(async () => {
          throw new Error('bundle read failed');
        }),
        logError,
        unlockPostResourceBundleWithCredits,
      },
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Internal server error' });
    expect(logError).toHaveBeenCalledWith('Post resource credit unlock failed:', expect.any(Error));
    expect(unlockPostResourceBundleWithCredits).not.toHaveBeenCalled();
  });

  it('gives the post resource credit unlock a way to send its notifications after the response', async () => {
    const notify = vi.fn(async () => null);
    const scheduled: Array<() => Promise<unknown>> = [];
    const unlockPostResourceBundleWithCredits = vi.fn(
      async ({ runAfterResponse }: { runAfterResponse?: (task: () => Promise<unknown>) => void }) => {
        runAfterResponse?.(notify);
        return {
          success: true as const,
          entitlement: 'post_resource_unlock' as const,
          postId: 'post-1',
          credits: 12,
          alreadyProcessed: false,
        };
      },
    );

    const response = await postResourceBundleCreditUnlockRouteResponse({
      request: createRequest('http://localhost/api/posts/post-1/resource-bundle/unlock-with-credits'),
      context: createPostContext(),
      dependencies: {
        createServiceClient: vi.fn(() => ({ service: 'admin' }) as unknown as SupabaseClient),
        createUserClient: () => createUserClient('buyer-1'),
        enforceBackendRateLimit: vi.fn(async () => ({
          allowed: true,
          limit: 20,
          remaining: 19,
          retryAfterSeconds: 0,
          resetAt: '2026-06-23T08:30:00.000Z',
        })),
        isPostResourceBundleBuyWithheld: vi.fn(async () => false),
        runAfterResponse: (task) => { scheduled.push(task); },
        unlockPostResourceBundleWithCredits,
      },
    });

    // The response is ready while the notification is only queued.
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      entitlement: 'post_resource_unlock',
      postId: 'post-1',
      credits: 12,
      alreadyProcessed: false,
    });
    expect(scheduled).toHaveLength(1);
    expect(notify).not.toHaveBeenCalled();

    await scheduled[0]();
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
