import { beforeEach, describe, expect, it, vi } from 'vitest';

const createUserClientMock = vi.hoisted(() => vi.fn());
const rpcMock = vi.hoisted(() => vi.fn(async () => ({
  data: {
    allowed: true,
    limit: 20,
    remaining: 19,
    retryAfterSeconds: 0,
    resetAt: '2026-06-21T06:30:00.000Z',
  },
  error: null,
})));
const adminClient = vi.hoisted(() => ({ service: 'admin', rpc: rpcMock }));
const createServiceClientFactory = vi.hoisted(() => vi.fn(() => adminClient));
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

function expectPrivateNoStoreTraceHeaders(response: Response, requestId: string) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('x-request-id')).toBe(requestId);
}

describe('marketplace admin route auth gates', () => {
  beforeEach(() => {
    vi.resetModules();
    createUserClientMock.mockReset();
    createServiceClientFactory.mockClear();
    rpcMock.mockReset();
    rpcMock.mockResolvedValue({
      data: {
        allowed: true,
        limit: 20,
        remaining: 19,
        retryAfterSeconds: 0,
        resetAt: '2026-06-21T06:30:00.000Z',
      },
      error: null,
    });
    unlockMarketplaceAssetWithCreditsMock.mockClear();
    unlockMarketplaceAssetWithCreditsMock.mockResolvedValue({
      success: true,
      entitlement: 'marketplace_unlock',
      assetId: 'asset-1',
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

  it('does not create an admin client before asset import authentication succeeds', async () => {
    const { POST } = await import('@/app/api/marketplace/assets/[assetId]/import/route');
    const response = await POST(
      new Request('http://localhost/api/marketplace/assets/asset-1/import', {
        method: 'POST',
        headers: { 'x-request-id': 'asset-import-auth-1' },
      }) as never,
      { params: Promise.resolve({ assetId: 'asset-1' }) }
    );

    expect(response.status).toBe(401);
    expectPrivateNoStoreTraceHeaders(response, 'asset-import-auth-1');
    expect(createServiceClientFactory).not.toHaveBeenCalled();
  });

  it('rate limits marketplace workflow imports before asset lookup or canvas creation', async () => {
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
        limit: 30,
        remaining: 0,
        retryAfterSeconds: 43,
        resetAt: '2026-06-21T06:30:00.000Z',
      },
      error: null,
    });

    const { POST } = await import('@/app/api/marketplace/assets/[assetId]/import/route');
    const response = await POST(
      new Request('http://localhost/api/marketplace/assets/asset-1/import', {
        method: 'POST',
        headers: { 'x-request-id': 'asset-import-rate-limit-1' },
      }) as never,
      { params: Promise.resolve({ assetId: 'asset-1' }) }
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('43');
    expectPrivateNoStoreTraceHeaders(response, 'asset-import-rate-limit-1');
    await expect(response.json()).resolves.toMatchObject({ code: 'RATE_LIMITED' });
    expect(rpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'marketplace-asset:import',
      p_subject_key: 'buyer-1',
      p_limit: 30,
      p_window_seconds: 600,
    });
  });

  it('does not create an admin client before asset credit unlock authentication succeeds', async () => {
    const { POST } = await import('@/app/api/marketplace/assets/[assetId]/unlock-with-credits/route');
    const response = await POST(
      new Request('http://localhost/api/marketplace/assets/asset-1/unlock-with-credits', {
        method: 'POST',
        headers: {
          authorization: 'Bearer private-token',
          'x-request-id': 'asset-credit-auth-1',
        },
      }) as never,
      { params: Promise.resolve({ assetId: 'asset-1' }) }
    );

    expect(response.status).toBe(401);
    expectPrivateNoStoreTraceHeaders(response, 'asset-credit-auth-1');
    expect(response.headers.has('authorization')).toBe(false);
    expect(Array.from(response.headers.entries()).join('\n')).not.toContain('private-token');
    expect(createServiceClientFactory).not.toHaveBeenCalled();
    expect(unlockMarketplaceAssetWithCreditsMock).not.toHaveBeenCalled();
  });

  it('rate limits marketplace credit unlocks before credit mutation work', async () => {
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
        limit: 20,
        remaining: 0,
        retryAfterSeconds: 37,
        resetAt: '2026-06-21T06:30:00.000Z',
      },
      error: null,
    });

    const { POST } = await import('@/app/api/marketplace/assets/[assetId]/unlock-with-credits/route');
    const response = await POST(
      new Request('http://localhost/api/marketplace/assets/asset-1/unlock-with-credits', {
        method: 'POST',
        headers: { 'x-request-id': 'asset-credit-rate-limit-1' },
      }) as never,
      { params: Promise.resolve({ assetId: 'asset-1' }) }
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('37');
    expectPrivateNoStoreTraceHeaders(response, 'asset-credit-rate-limit-1');
    await expect(response.json()).resolves.toMatchObject({ code: 'RATE_LIMITED' });
    expect(rpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'credit-unlock:spend',
      p_subject_key: 'buyer-1',
      p_limit: 20,
      p_window_seconds: 600,
    });
    expect(unlockMarketplaceAssetWithCreditsMock).not.toHaveBeenCalled();
  });

  it('runs marketplace credit unlocks after passing the backend rate limit', async () => {
    createUserClientMock.mockReturnValueOnce({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: 'buyer-1' } },
          error: null,
        })),
      },
    });

    const { POST } = await import('@/app/api/marketplace/assets/[assetId]/unlock-with-credits/route');
    const response = await POST(
      new Request('http://localhost/api/marketplace/assets/asset-1/unlock-with-credits', {
        method: 'POST',
        headers: { 'x-request-id': 'asset-credit-success-1' },
      }) as never,
      { params: Promise.resolve({ assetId: 'asset-1' }) }
    );

    expect(response.status).toBe(200);
    expectPrivateNoStoreTraceHeaders(response, 'asset-credit-success-1');
    expect(rpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'credit-unlock:spend',
      p_subject_key: 'buyer-1',
      p_limit: 20,
      p_window_seconds: 600,
    });
    expect(unlockMarketplaceAssetWithCreditsMock).toHaveBeenCalledWith({
      adminSupabase: adminClient,
      userId: 'buyer-1',
      assetId: 'asset-1',
    });
  });

  it('does not create an admin client before sales export authentication succeeds', async () => {
    const { GET } = await import('@/app/api/marketplace/sales/export/route');
    const response = await GET(new Request('http://localhost/api/marketplace/sales/export') as never);

    expect(response.status).toBe(401);
    expect(createServiceClientFactory).not.toHaveBeenCalled();
  });
});
