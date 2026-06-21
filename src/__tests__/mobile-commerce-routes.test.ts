import { beforeEach, describe, expect, it, vi } from 'vitest';

const createUserClientMock = vi.fn();
const createServiceClientFactory = vi.fn(() => ({ service: 'admin' }));
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
  completeMobileCreditPurchase: vi.fn(),
  completeMobileMarketplaceUnlock: vi.fn(),
  completeMobilePostResourceUnlock: vi.fn(),
  normalizeMobileCommercePayload: (...args: unknown[]) => normalizeMobileCommercePayloadMock(...args),
  restoreMobileEntitlements: (...args: unknown[]) => restoreMobileEntitlementsMock(...args),
  verifyMobilePurchase: (...args: unknown[]) => verifyMobilePurchaseMock(...args),
}));

describe('/api/mobile/commerce routes', () => {
  beforeEach(() => {
    vi.resetModules();
    createUserClientMock.mockReset();
    createServiceClientFactory.mockClear();
    normalizeMobileCommercePayloadMock.mockClear();
    verifyMobilePurchaseMock.mockClear();
    restoreMobileEntitlementsMock.mockClear();
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
});
