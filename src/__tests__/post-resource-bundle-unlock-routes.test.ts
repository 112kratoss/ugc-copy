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
const getBundleForOrderByPostIdMock = vi.hoisted(() => vi.fn());
const notifyPostResourceUnlockCompletedMock = vi.hoisted(() => vi.fn());
const unlockPostResourceBundleWithCreditsMock = vi.hoisted(() => vi.fn());
const afterMock = vi.hoisted(() => vi.fn());

class MockMobileCommerceError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = 'MobileCommerceError';
  }
}

vi.mock('next/server', async () => {
  const actual = await vi.importActual<typeof import('next/server')>('next/server');
  return {
    ...actual,
    after: afterMock,
  };
});

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

function expectPrivateNoStoreTraceHeaders(response: Response, requestId: string) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('x-request-id')).toBe(requestId);
}

describe('/api/posts/[postId]/resource-bundle unlock routes', () => {
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
    getBundleForOrderByPostIdMock.mockClear();
    notifyPostResourceUnlockCompletedMock.mockClear();
    afterMock.mockReset();
    unlockPostResourceBundleWithCreditsMock.mockClear();
    unlockPostResourceBundleWithCreditsMock.mockResolvedValue({
      success: true,
      entitlement: 'post_resource_unlock',
      postId: 'post-1',
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

  it('does not create an admin client before free unlock authentication succeeds', async () => {
    const { POST } = await import('@/app/api/posts/[postId]/resource-bundle/unlock-free/route');
    const response = await POST(
      new Request('http://localhost/api/posts/post-1/resource-bundle/unlock-free', {
        method: 'POST',
        headers: { 'x-request-id': 'post-free-auth-1' },
      }) as never,
      { params: Promise.resolve({ postId: 'post-1' }) }
    );

    expect(response.status).toBe(401);
    expectPrivateNoStoreTraceHeaders(response, 'post-free-auth-1');
    expect(createServiceClientFactory).not.toHaveBeenCalled();
    expect(getBundleForOrderByPostIdMock).not.toHaveBeenCalled();
    expect(notifyPostResourceUnlockCompletedMock).not.toHaveBeenCalled();
  });

  it('does not create an admin client before credit unlock authentication succeeds', async () => {
    const { POST } = await import('@/app/api/posts/[postId]/resource-bundle/unlock-with-credits/route');
    const response = await POST(
      new Request('http://localhost/api/posts/post-1/resource-bundle/unlock-with-credits', {
        method: 'POST',
        headers: {
          authorization: 'Bearer private-token',
          'x-request-id': 'post-credit-auth-1',
        },
      }) as never,
      { params: Promise.resolve({ postId: 'post-1' }) }
    );

    expect(response.status).toBe(401);
    expectPrivateNoStoreTraceHeaders(response, 'post-credit-auth-1');
    expect(response.headers.has('authorization')).toBe(false);
    expect(Array.from(response.headers.entries()).join('\n')).not.toContain('private-token');
    expect(createServiceClientFactory).not.toHaveBeenCalled();
    expect(unlockPostResourceBundleWithCreditsMock).not.toHaveBeenCalled();
  });

  it('rate limits post resource credit unlocks before credit mutation work', async () => {
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
        retryAfterSeconds: 41,
        resetAt: '2026-06-21T06:30:00.000Z',
      },
      error: null,
    });

    const { POST } = await import('@/app/api/posts/[postId]/resource-bundle/unlock-with-credits/route');
    const response = await POST(
      new Request('http://localhost/api/posts/post-1/resource-bundle/unlock-with-credits', {
        method: 'POST',
        headers: { 'x-request-id': 'post-credit-rate-limit-1' },
      }) as never,
      { params: Promise.resolve({ postId: 'post-1' }) }
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('41');
    expectPrivateNoStoreTraceHeaders(response, 'post-credit-rate-limit-1');
    await expect(response.json()).resolves.toMatchObject({ code: 'RATE_LIMITED' });
    expect(rpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'credit-unlock:spend',
      p_subject_key: 'buyer-1',
      p_limit: 20,
      p_window_seconds: 600,
    });
    expect(unlockPostResourceBundleWithCreditsMock).not.toHaveBeenCalled();
  });

  it('runs post resource credit unlocks after passing the backend rate limit', async () => {
    createUserClientMock.mockReturnValueOnce({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: 'buyer-1' } },
          error: null,
        })),
      },
    });

    const { POST } = await import('@/app/api/posts/[postId]/resource-bundle/unlock-with-credits/route');
    const response = await POST(
      new Request('http://localhost/api/posts/post-1/resource-bundle/unlock-with-credits', {
        method: 'POST',
        headers: { 'x-request-id': 'post-credit-success-1' },
      }) as never,
      { params: Promise.resolve({ postId: 'post-1' }) }
    );

    expect(response.status).toBe(200);
    expectPrivateNoStoreTraceHeaders(response, 'post-credit-success-1');
    expect(rpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'credit-unlock:spend',
      p_subject_key: 'buyer-1',
      p_limit: 20,
      p_window_seconds: 600,
    });
    expect(unlockPostResourceBundleWithCreditsMock).toHaveBeenCalledWith({
      adminSupabase: adminClient,
      userId: 'buyer-1',
      postId: 'post-1',
      runAfterResponse: expect.any(Function),
    });
  });

  it('queues the credit unlock notifications behind the response instead of sending them first', async () => {
    createUserClientMock.mockReturnValueOnce({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: 'buyer-1' } },
          error: null,
        })),
      },
    });
    const notify = vi.fn(async () => null);
    unlockPostResourceBundleWithCreditsMock.mockImplementationOnce(
      async ({ runAfterResponse }: { runAfterResponse?: (task: () => Promise<unknown>) => void }) => {
        runAfterResponse?.(notify);
        return { success: true, entitlement: 'post_resource_unlock', postId: 'post-1' };
      },
    );

    const { POST } = await import('@/app/api/posts/[postId]/resource-bundle/unlock-with-credits/route');
    const response = await POST(
      new Request('http://localhost/api/posts/post-1/resource-bundle/unlock-with-credits', {
        method: 'POST',
        headers: { 'x-request-id': 'post-credit-after-1' },
      }) as never,
      { params: Promise.resolve({ postId: 'post-1' }) }
    );

    // The route as deployed hands the task to Next's after(), which runs it
    // once the response has gone out.
    expect(response.status).toBe(200);
    expectPrivateNoStoreTraceHeaders(response, 'post-credit-after-1');
    expect(afterMock).toHaveBeenCalledTimes(1);
    expect(afterMock).toHaveBeenCalledWith(notify);
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not create an admin client before paid unlock verification authentication succeeds', async () => {
    const { POST } = await import('@/app/api/posts/[postId]/resource-bundle/verify/route');
    const response = await POST(
      new Request('http://localhost/api/posts/post-1/resource-bundle/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'post-verify-auth-1',
        },
        body: JSON.stringify({}),
      }) as never
    );

    expect(response.status).toBe(401);
    expectPrivateNoStoreTraceHeaders(response, 'post-verify-auth-1');
    expect(createServiceClientFactory).not.toHaveBeenCalled();
  });
});
