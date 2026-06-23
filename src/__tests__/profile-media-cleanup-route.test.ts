import { beforeEach, describe, expect, it, vi } from 'vitest';

const createUserClientMock = vi.fn();
const rpcMock = vi.fn(async () => ({
  data: {
    allowed: true,
    limit: 30,
    remaining: 29,
    retryAfterSeconds: 0,
    resetAt: '2026-06-21T06:30:00.000Z',
  },
  error: null,
}));
const removeMock = vi.fn(async () => ({ error: null }));
const storageFromMock = vi.fn(() => ({ remove: removeMock }));
const adminClient = {
  rpc: rpcMock,
  storage: {
    from: storageFromMock,
  },
};
const createServiceClientFactory = vi.fn(() => adminClient);

vi.mock('@/lib/server-helpers', () => ({
  createUserClient: (request: Request) => createUserClientMock(request),
  createServiceClient: () => createServiceClientFactory(),
}));

function expectPrivateNoStoreTraceHeaders(response: Response, requestId: string) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('x-request-id')).toBe(requestId);
}

describe('/api/profile/media/cleanup route', () => {
  beforeEach(() => {
    vi.resetModules();
    createUserClientMock.mockReset();
    createServiceClientFactory.mockClear();
    rpcMock.mockReset();
    rpcMock.mockResolvedValue({
      data: {
        allowed: true,
        limit: 30,
        remaining: 29,
        retryAfterSeconds: 0,
        resetAt: '2026-06-21T06:30:00.000Z',
      },
      error: null,
    });
    storageFromMock.mockClear();
    removeMock.mockReset();
    removeMock.mockResolvedValue({ error: null });
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
    const { POST } = await import('@/app/api/profile/media/cleanup/route');
    const response = await POST(
      new Request('http://localhost/api/profile/media/cleanup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'profile-media-cleanup-auth-1',
        },
        body: JSON.stringify({ paths: ['user-1/avatar.png'] }),
      }) as never
    );

    expect(response.status).toBe(401);
    expectPrivateNoStoreTraceHeaders(response, 'profile-media-cleanup-auth-1');
    expect(createServiceClientFactory).not.toHaveBeenCalled();
  });

  it('rejects cleanup paths outside the authenticated user profile folder', async () => {
    createUserClientMock.mockReturnValueOnce({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: 'user-1' } },
          error: null,
        })),
      },
    });

    const { POST } = await import('@/app/api/profile/media/cleanup/route');
    const response = await POST(
      new Request('http://localhost/api/profile/media/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: ['user-2/avatar.png'] }),
      }) as never
    );

    expect(response.status).toBe(400);
    expect(createServiceClientFactory).not.toHaveBeenCalled();
    expect(removeMock).not.toHaveBeenCalled();
  });

  it('removes authenticated user profile media after passing the backend rate limit', async () => {
    createUserClientMock.mockReturnValueOnce({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: 'user-1' } },
          error: null,
        })),
      },
    });

    const { POST } = await import('@/app/api/profile/media/cleanup/route');
    const response = await POST(
      new Request('http://localhost/api/profile/media/cleanup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'profile-media-cleanup-success-1',
        },
        body: JSON.stringify({
          paths: [
            'user-1/avatar-server-issued.png',
            'user-1/cover-server-issued.png',
          ],
        }),
      }) as never
    );

    expect(response.status).toBe(200);
    expectPrivateNoStoreTraceHeaders(response, 'profile-media-cleanup-success-1');
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(rpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'profile-media-upload:cleanup',
      p_subject_key: 'user-1',
      p_limit: 30,
      p_window_seconds: 600,
    });
    expect(storageFromMock).toHaveBeenCalledWith('profiles');
    expect(removeMock).toHaveBeenCalledWith([
      'user-1/avatar-server-issued.png',
      'user-1/cover-server-issued.png',
    ]);
  });
});
