import { beforeEach, describe, expect, it, vi } from 'vitest';

const createUserClientMock = vi.fn();
const createServiceClientFactory = vi.fn(() => ({ service: 'admin' }));
const getBundleForOrderByPostIdMock = vi.fn();
const getPostResourceBundlePriceQuoteMock = vi.fn();

vi.mock('@/lib/server-helpers', () => ({
  createUserClient: (request: Request) => createUserClientMock(request),
  createServiceClient: () => createServiceClientFactory(),
}));

vi.mock('@/lib/post-resource-bundles-server', () => ({
  getBundleForOrderByPostId: (...args: unknown[]) => getBundleForOrderByPostIdMock(...args),
  getPostResourceBundlePriceQuote: (...args: unknown[]) => getPostResourceBundlePriceQuoteMock(...args),
}));

vi.mock('razorpay', () => ({
  default: vi.fn(() => ({
    orders: {
      create: vi.fn(),
    },
  })),
}));

describe('/api/posts/[postId]/resource-bundle/order route', () => {
  beforeEach(() => {
    vi.resetModules();
    createUserClientMock.mockReset();
    createServiceClientFactory.mockClear();
    getBundleForOrderByPostIdMock.mockClear();
    getPostResourceBundlePriceQuoteMock.mockClear();
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
    const { POST } = await import('@/app/api/posts/[postId]/resource-bundle/order/route');
    const response = await POST(
      new Request('http://localhost/api/posts/post-1/resource-bundle/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale: 'en-US' }),
      }) as never,
      { params: Promise.resolve({ postId: 'post-1' }) }
    );

    expect(response.status).toBe(401);
    expect(createServiceClientFactory).not.toHaveBeenCalled();
    expect(getBundleForOrderByPostIdMock).not.toHaveBeenCalled();
    expect(getPostResourceBundlePriceQuoteMock).not.toHaveBeenCalled();
  });
});
