import { beforeEach, describe, expect, it, vi } from 'vitest';

const createUserClientMock = vi.fn();
const createServiceClientFactory = vi.fn(() => ({ service: 'admin' }));
const getMarketplacePriceQuoteMock = vi.fn();

vi.mock('@/lib/server-helpers', () => ({
  createUserClient: (request: Request) => createUserClientMock(request),
  createServiceClient: () => createServiceClientFactory(),
}));

vi.mock('@/lib/marketplace-server', () => ({
  getMarketplacePriceQuote: (...args: unknown[]) => getMarketplacePriceQuoteMock(...args),
}));

vi.mock('razorpay', () => ({
  default: vi.fn(() => ({
    orders: {
      create: vi.fn(),
    },
  })),
}));

describe('/api/marketplace/order route', () => {
  beforeEach(() => {
    vi.resetModules();
    createUserClientMock.mockReset();
    createServiceClientFactory.mockClear();
    getMarketplacePriceQuoteMock.mockClear();
    createUserClientMock.mockReturnValue({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: null },
          error: new Error('missing session'),
        })),
      },
    });
  });

  it('does not create an admin client before authentication succeeds', async () => {
    const { POST } = await import('@/app/api/marketplace/order/route');
    const response = await POST(
      new Request('http://localhost/api/marketplace/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId: 'asset-1' }),
      }) as never
    );

    expect(response.status).toBe(401);
    expect(createServiceClientFactory).not.toHaveBeenCalled();
    expect(getMarketplacePriceQuoteMock).not.toHaveBeenCalled();
  });
});
