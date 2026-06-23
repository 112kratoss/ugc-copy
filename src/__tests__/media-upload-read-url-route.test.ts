import { beforeEach, describe, expect, it, vi } from 'vitest';

import mobileApiContract from '../../contracts/mobile-api-v1.json';

const createUserClientMock = vi.fn();
const rpcMock = vi.fn(async () => ({
  data: {
    allowed: true,
    limit: 120,
    remaining: 119,
    retryAfterSeconds: 0,
    resetAt: '2026-06-22T06:30:00.000Z',
  },
  error: null,
}));
const createSignedUrlMock = vi.fn(async () => ({
  data: {
    signedUrl: 'https://storage.example.test/signed/reference.png',
  },
  error: null,
}));
const storageFromMock = vi.fn(() => ({
  createSignedUrl: createSignedUrlMock,
}));
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

describe('/api/uploads/media/read-url route', () => {
  beforeEach(() => {
    vi.resetModules();
    createUserClientMock.mockReset();
    createServiceClientFactory.mockClear();
    rpcMock.mockReset();
    rpcMock.mockResolvedValue({
      data: {
        allowed: true,
        limit: 120,
        remaining: 119,
        retryAfterSeconds: 0,
        resetAt: '2026-06-22T06:30:00.000Z',
      },
      error: null,
    });
    storageFromMock.mockClear();
    createSignedUrlMock.mockReset();
    createSignedUrlMock.mockResolvedValue({
      data: {
        signedUrl: 'https://storage.example.test/signed/reference.png',
      },
      error: null,
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

  it('does not create an admin client before authentication succeeds', async () => {
    const { POST } = await import('@/app/api/uploads/media/read-url/route');
    const response = await POST(
      new Request('http://localhost/api/uploads/media/read-url', {
        method: 'POST',
        headers: {
          authorization: 'Bearer private-token',
          'x-request-id': 'media-read-auth-1',
        },
      }) as never
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('media-read-auth-1');
    expect(response.headers.has('authorization')).toBe(false);
    expect(Array.from(response.headers.entries()).join('\n')).not.toContain('private-token');
    expect(createServiceClientFactory).not.toHaveBeenCalled();
  });

  it('creates a rate-limited read URL for an owned temporary media path', async () => {
    createUserClientMock.mockReturnValueOnce({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: 'user-1' } },
          error: null,
        })),
      },
    });

    const { POST } = await import('@/app/api/uploads/media/read-url/route');
    const response = await POST(
      new Request('http://localhost/api/uploads/media/read-url', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'media-read-success-1',
        },
        body: JSON.stringify({
          storagePath: 'uploads/user-1/reference.png',
        }),
      }) as never
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('media-read-success-1');
    await expect(response.json()).resolves.toEqual(mobileApiContract.endpoints.mediaReadUrl.response);
    expect(rpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'temporary-media-upload:read-url',
      p_subject_key: 'user-1',
      p_limit: 120,
      p_window_seconds: 600,
    });
    expect(storageFromMock).toHaveBeenCalledWith('uploads');
    expect(createSignedUrlMock).toHaveBeenCalledWith('user-1/reference.png', 3600);
  });

  it('rejects unowned or malformed paths before storage signing work', async () => {
    createUserClientMock.mockReturnValueOnce({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: 'user-1' } },
          error: null,
        })),
      },
    });

    const { POST } = await import('@/app/api/uploads/media/read-url/route');
    const response = await POST(
      new Request('http://localhost/api/uploads/media/read-url', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'media-read-forbidden-1',
        },
        body: JSON.stringify({
          storagePath: 'uploads/user-2/reference.png',
        }),
      }) as never
    );

    expect(response.status).toBe(403);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('media-read-forbidden-1');
    await expect(response.json()).resolves.toEqual({
      error: 'Media path is not available.',
    });
    expect(storageFromMock).not.toHaveBeenCalled();
    expect(createSignedUrlMock).not.toHaveBeenCalled();
  });

  it('rate limits read URL creation before storage signing work', async () => {
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
        limit: 120,
        remaining: 0,
        retryAfterSeconds: 31,
        resetAt: '2026-06-22T06:30:00.000Z',
      },
      error: null,
    });

    const { POST } = await import('@/app/api/uploads/media/read-url/route');
    const response = await POST(
      new Request('http://localhost/api/uploads/media/read-url', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'media-read-rate-limit-1',
        },
        body: JSON.stringify({
          storagePath: 'uploads/user-1/reference.png',
        }),
      }) as never
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('31');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('media-read-rate-limit-1');
    await expect(response.json()).resolves.toMatchObject({ code: 'RATE_LIMITED' });
    expect(storageFromMock).not.toHaveBeenCalled();
    expect(createSignedUrlMock).not.toHaveBeenCalled();
  });
});
