import { beforeEach, describe, expect, it, vi } from 'vitest';

const createUserClientMock = vi.fn();
const rpcMock = vi.fn(async () => ({
  data: {
    allowed: true,
    limit: 12,
    remaining: 11,
    retryAfterSeconds: 0,
    resetAt: '2026-06-21T06:30:00.000Z',
  },
  error: null,
}));
const adminClient = { service: 'admin', rpc: rpcMock };
const createServiceClientFactory = vi.fn(() => adminClient);
const completeMobileCreditPurchaseMock = vi.fn();
const completeMobileMarketplaceUnlockMock = vi.fn();
const completeMobilePostResourceUnlockMock = vi.fn();
const normalizeMobileCommercePayloadMock = vi.fn();
const verifyMobilePurchaseMock = vi.fn();
const restoreMobileEntitlementsMock = vi.fn();

class MockMobileCommerceError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = 'MobileCommerceError';
  }
}

vi.mock('@/lib/server-helpers', () => ({
  createUserClient: (request: Request) => createUserClientMock(request),
  createServiceClient: () => createServiceClientFactory(),
}));

vi.mock('@/lib/mobile-commerce', () => ({
  MobileCommerceError: MockMobileCommerceError,
  completeMobileCreditPurchase: (...args: unknown[]) => completeMobileCreditPurchaseMock(...args),
  completeMobileMarketplaceUnlock: (...args: unknown[]) => completeMobileMarketplaceUnlockMock(...args),
  completeMobilePostResourceUnlock: (...args: unknown[]) => completeMobilePostResourceUnlockMock(...args),
  normalizeMobileCommercePayload: (...args: unknown[]) => normalizeMobileCommercePayloadMock(...args),
  restoreMobileEntitlements: (...args: unknown[]) => restoreMobileEntitlementsMock(...args),
  verifyMobilePurchase: (...args: unknown[]) => verifyMobilePurchaseMock(...args),
}));

describe('/api/mobile/commerce routes', () => {
  beforeEach(() => {
    vi.resetModules();
    createUserClientMock.mockReset();
    createServiceClientFactory.mockClear();
    rpcMock.mockReset();
    rpcMock.mockResolvedValue({
      data: {
        allowed: true,
        limit: 12,
        remaining: 11,
        retryAfterSeconds: 0,
        resetAt: '2026-06-21T06:30:00.000Z',
      },
      error: null,
    });
    completeMobileCreditPurchaseMock.mockClear();
    completeMobileCreditPurchaseMock.mockResolvedValue({
      success: true,
      entitlement: 'credits',
      credits: 120,
    });
    completeMobileMarketplaceUnlockMock.mockClear();
    completeMobilePostResourceUnlockMock.mockClear();
    normalizeMobileCommercePayloadMock.mockClear();
    normalizeMobileCommercePayloadMock.mockReturnValue({
      productId: 'credits-1',
      provider: 'app_store',
      transactionId: 'tx-1',
      receiptToken: 'receipt-1',
      entitlement: { type: 'credits' },
    });
    verifyMobilePurchaseMock.mockClear();
    verifyMobilePurchaseMock.mockResolvedValue({
      provider: 'app_store',
      transactionId: 'tx-1',
    });
    restoreMobileEntitlementsMock.mockClear();
    restoreMobileEntitlementsMock.mockResolvedValue({
      success: true,
      entitlements: [],
      credits: 120,
    });
    createUserClientMock.mockReturnValue({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: null },
          error: new Error('missing session'),
        })),
      },
    });
  });

  it('does not create an admin client before sync authentication succeeds', async () => {
    const { POST } = await import('@/app/api/mobile/commerce/sync/route');
    const response = await POST(
      new Request('http://localhost/api/mobile/commerce/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: 'credits-1' }),
      }) as never
    );

    expect(response.status).toBe(401);
    expect(createServiceClientFactory).not.toHaveBeenCalled();
    expect(normalizeMobileCommercePayloadMock).not.toHaveBeenCalled();
    expect(verifyMobilePurchaseMock).not.toHaveBeenCalled();
  });

  it('rate limits commerce sync before parsing or verifying purchases', async () => {
    createUserClientMock.mockReturnValueOnce({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: 'buyer-1' } },
          error: null,
        })),
      },
    });
    rpcMock.mockResolvedValue({
      data: {
        allowed: false,
        limit: 12,
        remaining: 0,
        retryAfterSeconds: 43,
        resetAt: '2026-06-21T06:30:00.000Z',
      },
      error: null,
    });

    const { POST } = await import('@/app/api/mobile/commerce/sync/route');
    const response = await POST(
      new Request('http://localhost/api/mobile/commerce/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: 'credits-1' }),
      }) as never
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('43');
    await expect(response.json()).resolves.toMatchObject({ code: 'RATE_LIMITED' });
    expect(rpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'mobile-commerce:sync',
      p_subject_key: 'buyer-1',
      p_limit: 12,
      p_window_seconds: 600,
    });
    expect(normalizeMobileCommercePayloadMock).not.toHaveBeenCalled();
    expect(verifyMobilePurchaseMock).not.toHaveBeenCalled();
    expect(completeMobileCreditPurchaseMock).not.toHaveBeenCalled();
  });

  it('runs commerce sync after passing the backend rate limit', async () => {
    createUserClientMock.mockReturnValueOnce({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: 'buyer-1' } },
          error: null,
        })),
      },
    });

    const { POST } = await import('@/app/api/mobile/commerce/sync/route');
    const response = await POST(
      new Request('http://localhost/api/mobile/commerce/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: 'credits-1' }),
      }) as never
    );

    expect(response.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'mobile-commerce:sync',
      p_subject_key: 'buyer-1',
      p_limit: 12,
      p_window_seconds: 600,
    });
    expect(verifyMobilePurchaseMock).toHaveBeenCalledWith({
      userId: 'buyer-1',
      productId: 'credits-1',
      provider: 'app_store',
      transactionId: 'tx-1',
      receiptToken: 'receipt-1',
    });
    expect(completeMobileCreditPurchaseMock).toHaveBeenCalledWith({
      adminSupabase: adminClient,
      userId: 'buyer-1',
      productId: 'credits-1',
      provider: 'app_store',
      transactionId: 'tx-1',
    });
  });

  it('does not create an admin client before restore authentication succeeds', async () => {
    const { POST } = await import('@/app/api/mobile/commerce/restore/route');
    const response = await POST(
      new Request('http://localhost/api/mobile/commerce/restore', {
        method: 'POST',
      }) as never
    );

    expect(response.status).toBe(401);
    expect(createServiceClientFactory).not.toHaveBeenCalled();
    expect(restoreMobileEntitlementsMock).not.toHaveBeenCalled();
  });

  it('rate limits commerce restore before RevenueCat restore work', async () => {
    createUserClientMock.mockReturnValueOnce({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: 'buyer-1' } },
          error: null,
        })),
      },
    });
    rpcMock.mockResolvedValue({
      data: {
        allowed: false,
        limit: 6,
        remaining: 0,
        retryAfterSeconds: 88,
        resetAt: '2026-06-21T06:30:00.000Z',
      },
      error: null,
    });

    const { POST } = await import('@/app/api/mobile/commerce/restore/route');
    const response = await POST(
      new Request('http://localhost/api/mobile/commerce/restore', {
        method: 'POST',
      }) as never
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('88');
    await expect(response.json()).resolves.toMatchObject({ code: 'RATE_LIMITED' });
    expect(rpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'mobile-commerce:restore',
      p_subject_key: 'buyer-1',
      p_limit: 6,
      p_window_seconds: 600,
    });
    expect(restoreMobileEntitlementsMock).not.toHaveBeenCalled();
  });

  it('runs commerce restore after passing the backend rate limit', async () => {
    createUserClientMock.mockReturnValueOnce({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: 'buyer-1' } },
          error: null,
        })),
      },
    });

    const { POST } = await import('@/app/api/mobile/commerce/restore/route');
    const response = await POST(
      new Request('http://localhost/api/mobile/commerce/restore', {
        method: 'POST',
      }) as never
    );

    expect(response.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'mobile-commerce:restore',
      p_subject_key: 'buyer-1',
      p_limit: 6,
      p_window_seconds: 600,
    });
    expect(restoreMobileEntitlementsMock).toHaveBeenCalledWith(adminClient, 'buyer-1');
  });
});
