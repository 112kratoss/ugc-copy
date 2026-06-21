import { beforeEach, describe, expect, it, vi } from 'vitest';

const createUserClientMock = vi.hoisted(() => vi.fn());
const createServiceClientFactory = vi.hoisted(() => vi.fn(() => ({ service: 'admin' })));
const unlockMarketplaceAssetWithCreditsMock = vi.hoisted(() => vi.fn());

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
  unlockMarketplaceAssetWithCredits: (...args: unknown[]) => unlockMarketplaceAssetWithCreditsMock(...args),
}));

describe('marketplace admin route auth gates', () => {
  beforeEach(() => {
    vi.resetModules();
    createUserClientMock.mockReset();
    createServiceClientFactory.mockClear();
    unlockMarketplaceAssetWithCreditsMock.mockClear();
    createUserClientMock.mockReturnValue({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: null },
          error: new Error('missing session'),
        })),
      },
    });
  });

  it('does not create an admin client before asset import authentication succeeds', async () => {
    const { POST } = await import('@/app/api/marketplace/assets/[assetId]/import/route');
    const response = await POST(
      new Request('http://localhost/api/marketplace/assets/asset-1/import', {
        method: 'POST',
      }) as never,
      { params: Promise.resolve({ assetId: 'asset-1' }) }
    );

    expect(response.status).toBe(401);
    expect(createServiceClientFactory).not.toHaveBeenCalled();
  });

  it('does not create an admin client before asset credit unlock authentication succeeds', async () => {
    const { POST } = await import('@/app/api/marketplace/assets/[assetId]/unlock-with-credits/route');
    const response = await POST(
      new Request('http://localhost/api/marketplace/assets/asset-1/unlock-with-credits', {
        method: 'POST',
      }) as never,
      { params: Promise.resolve({ assetId: 'asset-1' }) }
    );

    expect(response.status).toBe(401);
    expect(createServiceClientFactory).not.toHaveBeenCalled();
    expect(unlockMarketplaceAssetWithCreditsMock).not.toHaveBeenCalled();
  });

  it('does not create an admin client before sales export authentication succeeds', async () => {
    const { GET } = await import('@/app/api/marketplace/sales/export/route');
    const response = await GET(new Request('http://localhost/api/marketplace/sales/export') as never);

    expect(response.status).toBe(401);
    expect(createServiceClientFactory).not.toHaveBeenCalled();
  });
});
