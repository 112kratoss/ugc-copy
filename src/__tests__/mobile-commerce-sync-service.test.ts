import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  completeMobileCreditPurchase: vi.fn(),
  completeMobileMarketplaceUnlock: vi.fn(),
  completeMobilePostResourceUnlock: vi.fn(),
  normalizeMobileCommercePayload: vi.fn(),
  verifyMobilePurchase: vi.fn(),
}));

class MockMobileCommerceError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = 'MobileCommerceError';
  }
}

vi.mock('@/lib/mobile-commerce', () => ({
  MobileCommerceError: MockMobileCommerceError,
  completeMobileCreditPurchase: (...args: unknown[]) => mocks.completeMobileCreditPurchase(...args),
  completeMobileMarketplaceUnlock: (...args: unknown[]) => mocks.completeMobileMarketplaceUnlock(...args),
  completeMobilePostResourceUnlock: (...args: unknown[]) => mocks.completeMobilePostResourceUnlock(...args),
  normalizeMobileCommercePayload: (...args: unknown[]) => mocks.normalizeMobileCommercePayload(...args),
  verifyMobilePurchase: (...args: unknown[]) => mocks.verifyMobilePurchase(...args),
}));

function createRateLimitRpc({
  allowed = true,
  limit = 12,
  remaining = 11,
  retryAfterSeconds = 0,
  resetAt = '2026-06-22T06:30:00.000Z',
} = {}) {
  return vi.fn(async () => ({
    data: {
      allowed,
      limit,
      remaining,
      retryAfterSeconds,
      resetAt,
    },
    error: null,
  }));
}

function createUserSupabaseMock(options: { userId?: string | null; authError?: Error | null } = {}) {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: options.userId === null || options.authError ? null : { id: options.userId ?? 'buyer-1' } },
        error: options.authError ?? null,
      })),
    },
  };
}

describe('mobile commerce sync service', () => {
  let rateLimitRpc: ReturnType<typeof createRateLimitRpc>;
  let adminSupabase: { service: string; rpc: ReturnType<typeof createRateLimitRpc> };
  let getAdminSupabase: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    rateLimitRpc = createRateLimitRpc();
    adminSupabase = { service: 'admin', rpc: rateLimitRpc };
    getAdminSupabase = vi.fn(() => adminSupabase);
    mocks.completeMobileCreditPurchase.mockReset();
    mocks.completeMobileMarketplaceUnlock.mockReset();
    mocks.completeMobilePostResourceUnlock.mockReset();
    mocks.normalizeMobileCommercePayload.mockReset();
    mocks.verifyMobilePurchase.mockReset();
    mocks.normalizeMobileCommercePayload.mockReturnValue({
      productId: 'credits-1',
      provider: 'app_store',
      transactionId: 'tx-1',
      receiptToken: 'receipt-1',
      entitlement: { type: 'credits' },
    });
    mocks.verifyMobilePurchase.mockResolvedValue({
      provider: 'app_store',
      transactionId: 'verified-tx-1',
    });
    mocks.completeMobileCreditPurchase.mockResolvedValue({
      success: true,
      entitlement: 'credits',
      credits: 42,
    });
    mocks.completeMobileMarketplaceUnlock.mockResolvedValue({
      success: true,
      entitlement: 'marketplace_unlock',
      assetId: 'asset-1',
    });
    mocks.completeMobilePostResourceUnlock.mockResolvedValue({
      success: true,
      entitlement: 'post_resource_unlock',
      postId: 'post-1',
    });
  });

  it('returns unauthorized before privileged work when the mobile session is missing', async () => {
    const { syncMobileCommerceForRoute } = await import('@/lib/mobile-commerce-sync-service');
    const result = await syncMobileCommerceForRoute({
      getAdminSupabase,
      requestBody: { productId: 'credits-1' },
      userSupabase: createUserSupabaseMock({ userId: null }),
    });

    expect(result).toEqual({
      ok: false,
      body: { error: 'Unauthorized' },
      status: 401,
    });
    expect(getAdminSupabase).not.toHaveBeenCalled();
    expect(mocks.normalizeMobileCommercePayload).not.toHaveBeenCalled();
    expect(mocks.verifyMobilePurchase).not.toHaveBeenCalled();
  });

  it('rate limits before parsing or verifying mobile purchases', async () => {
    rateLimitRpc = createRateLimitRpc({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 43,
    });
    adminSupabase = { service: 'admin', rpc: rateLimitRpc };
    getAdminSupabase = vi.fn(() => adminSupabase);

    const { syncMobileCommerceForRoute } = await import('@/lib/mobile-commerce-sync-service');
    const result = await syncMobileCommerceForRoute({
      getAdminSupabase,
      requestBody: { productId: 'credits-1' },
      userSupabase: createUserSupabaseMock(),
    });

    expect(result).toMatchObject({
      ok: false,
      status: 429,
      rateLimitError: expect.any(Error),
    });
    expect(rateLimitRpc).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'mobile-commerce:sync',
      p_subject_key: 'buyer-1',
      p_limit: 12,
      p_window_seconds: 600,
    });
    expect(mocks.normalizeMobileCommercePayload).not.toHaveBeenCalled();
    expect(mocks.verifyMobilePurchase).not.toHaveBeenCalled();
  });

  it('verifies and completes credit purchases after the backend rate limit', async () => {
    const { syncMobileCommerceForRoute } = await import('@/lib/mobile-commerce-sync-service');
    const result = await syncMobileCommerceForRoute({
      getAdminSupabase,
      requestBody: { productId: 'credits-1' },
      userSupabase: createUserSupabaseMock(),
    });

    expect(result).toEqual({
      ok: true,
      body: {
        success: true,
        entitlement: 'credits',
        credits: 42,
      },
    });
    expect(mocks.verifyMobilePurchase).toHaveBeenCalledWith({
      userId: 'buyer-1',
      productId: 'credits-1',
      provider: 'app_store',
      transactionId: 'tx-1',
      receiptToken: 'receipt-1',
    });
    expect(mocks.completeMobileCreditPurchase).toHaveBeenCalledWith({
      adminSupabase,
      userId: 'buyer-1',
      productId: 'credits-1',
      provider: 'app_store',
      transactionId: 'verified-tx-1',
    });
  });

  it('routes verified marketplace and post resource entitlements to their completion services', async () => {
    const { syncMobileCommerceForRoute } = await import('@/lib/mobile-commerce-sync-service');

    mocks.normalizeMobileCommercePayload.mockReturnValueOnce({
      productId: 'asset-product-1',
      provider: 'play_store',
      transactionId: 'tx-marketplace-1',
      receiptToken: 'receipt-marketplace-1',
      entitlement: { type: 'marketplace_unlock', assetId: 'asset-1' },
    });
    mocks.verifyMobilePurchase.mockResolvedValueOnce({
      provider: 'play_store',
      transactionId: 'verified-marketplace-1',
    });

    const marketplaceResult = await syncMobileCommerceForRoute({
      getAdminSupabase,
      requestBody: { productId: 'asset-product-1' },
      userSupabase: createUserSupabaseMock(),
    });

    mocks.normalizeMobileCommercePayload.mockReturnValueOnce({
      productId: 'post-product-1',
      provider: 'app_store',
      transactionId: 'tx-post-1',
      receiptToken: 'receipt-post-1',
      entitlement: { type: 'post_resource_unlock', postId: 'post-1' },
    });
    mocks.verifyMobilePurchase.mockResolvedValueOnce({
      provider: 'app_store',
      transactionId: 'verified-post-1',
    });

    const postResult = await syncMobileCommerceForRoute({
      getAdminSupabase,
      requestBody: { productId: 'post-product-1' },
      userSupabase: createUserSupabaseMock(),
    });

    expect(marketplaceResult.body).toEqual({
      success: true,
      entitlement: 'marketplace_unlock',
      assetId: 'asset-1',
    });
    expect(postResult.body).toEqual({
      success: true,
      entitlement: 'post_resource_unlock',
      postId: 'post-1',
    });
    expect(mocks.completeMobileMarketplaceUnlock).toHaveBeenCalledWith({
      adminSupabase,
      userId: 'buyer-1',
      assetId: 'asset-1',
      provider: 'play_store',
      transactionId: 'verified-marketplace-1',
    });
    expect(mocks.completeMobilePostResourceUnlock).toHaveBeenCalledWith({
      adminSupabase,
      userId: 'buyer-1',
      postId: 'post-1',
      provider: 'app_store',
      transactionId: 'verified-post-1',
    });
  });
});
