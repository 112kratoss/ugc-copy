import { beforeEach, describe, expect, it, vi } from 'vitest';

const createUserClientMock = vi.hoisted(() => vi.fn());
const createServiceClientFactory = vi.hoisted(() => vi.fn(() => ({ service: 'admin' })));
const getBundleForOrderByPostIdMock = vi.hoisted(() => vi.fn());
const notifyPostResourceUnlockCompletedMock = vi.hoisted(() => vi.fn());
const unlockPostResourceBundleWithCreditsMock = vi.hoisted(() => vi.fn());

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

vi.mock('@/lib/post-resource-bundles-server', () => ({
  getBundleForOrderByPostId: (...args: unknown[]) => getBundleForOrderByPostIdMock(...args),
}));

vi.mock('@/lib/mobile-notifications', () => ({
  notifyPostResourceUnlockCompleted: (...args: unknown[]) => notifyPostResourceUnlockCompletedMock(...args),
}));

vi.mock('@/lib/mobile-commerce', () => ({
  MobileCommerceError: MockMobileCommerceError,
  unlockPostResourceBundleWithCredits: (...args: unknown[]) => unlockPostResourceBundleWithCreditsMock(...args),
}));

describe('/api/posts/[postId]/resource-bundle unlock routes', () => {
  beforeEach(() => {
    vi.resetModules();
    createUserClientMock.mockReset();
    createServiceClientFactory.mockClear();
    getBundleForOrderByPostIdMock.mockClear();
    notifyPostResourceUnlockCompletedMock.mockClear();
    unlockPostResourceBundleWithCreditsMock.mockClear();
    createUserClientMock.mockReturnValue({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: null },
          error: new Error('missing session'),
        })),
      },
    });
  });

  it('does not create an admin client before free unlock authentication succeeds', async () => {
    const { POST } = await import('@/app/api/posts/[postId]/resource-bundle/unlock-free/route');
    const response = await POST(
      new Request('http://localhost/api/posts/post-1/resource-bundle/unlock-free', {
        method: 'POST',
      }) as never,
      { params: Promise.resolve({ postId: 'post-1' }) }
    );

    expect(response.status).toBe(401);
    expect(createServiceClientFactory).not.toHaveBeenCalled();
    expect(getBundleForOrderByPostIdMock).not.toHaveBeenCalled();
    expect(notifyPostResourceUnlockCompletedMock).not.toHaveBeenCalled();
  });

  it('does not create an admin client before credit unlock authentication succeeds', async () => {
    const { POST } = await import('@/app/api/posts/[postId]/resource-bundle/unlock-with-credits/route');
    const response = await POST(
      new Request('http://localhost/api/posts/post-1/resource-bundle/unlock-with-credits', {
        method: 'POST',
      }) as never,
      { params: Promise.resolve({ postId: 'post-1' }) }
    );

    expect(response.status).toBe(401);
    expect(createServiceClientFactory).not.toHaveBeenCalled();
    expect(unlockPostResourceBundleWithCreditsMock).not.toHaveBeenCalled();
  });

  it('does not create an admin client before paid unlock verification authentication succeeds', async () => {
    const { POST } = await import('@/app/api/posts/[postId]/resource-bundle/verify/route');
    const response = await POST(
      new Request('http://localhost/api/posts/post-1/resource-bundle/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }) as never
    );

    expect(response.status).toBe(401);
    expect(createServiceClientFactory).not.toHaveBeenCalled();
  });
});
