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
const storageUploadMock = vi.fn(async () => ({ data: null, error: null }));
const storageFromMock = vi.fn(() => ({ upload: storageUploadMock }));
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

describe('/api/posts/resource-files route', () => {
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
    storageUploadMock.mockClear();
    storageUploadMock.mockResolvedValue({ data: null, error: null });
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
    const { POST } = await import('@/app/api/posts/resource-files/route');
    const response = await POST(
      new Request('http://localhost/api/posts/resource-files', {
        method: 'POST',
      }) as never
    );

    expect(response.status).toBe(401);
    expect(createServiceClientFactory).not.toHaveBeenCalled();
  });

  it('rate limits resource file uploads before multipart storage work', async () => {
    createUserClientMock.mockReturnValueOnce({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: 'user-1' } },
          error: null,
        })),
      },
    });
    rpcMock.mockResolvedValueOnce({
      data: {
        allowed: false,
        limit: 30,
        remaining: 0,
        retryAfterSeconds: 47,
        resetAt: '2026-06-21T06:30:00.000Z',
      },
      error: null,
    });

    const formData = new FormData();
    formData.set('file', new File(['hello'], 'guide.pdf', { type: 'application/pdf' }));

    const { POST } = await import('@/app/api/posts/resource-files/route');
    const response = await POST(
      new Request('http://localhost/api/posts/resource-files', {
        method: 'POST',
        body: formData,
      }) as never
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('47');
    await expect(response.json()).resolves.toMatchObject({ code: 'RATE_LIMITED' });
    expect(rpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'post-resource-file:upload',
      p_subject_key: 'user-1',
      p_limit: 30,
      p_window_seconds: 600,
    });
    expect(storageFromMock).not.toHaveBeenCalled();
    expect(storageUploadMock).not.toHaveBeenCalled();
  });
});
