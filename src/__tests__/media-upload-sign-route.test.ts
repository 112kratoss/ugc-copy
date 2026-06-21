import { beforeEach, describe, expect, it, vi } from 'vitest';

const createUserClientMock = vi.fn();
const rpcMock = vi.fn(async () => ({
  data: {
    allowed: true,
    limit: 60,
    remaining: 59,
    retryAfterSeconds: 0,
    resetAt: '2026-06-21T06:30:00.000Z',
  },
  error: null,
}));
const createSignedUploadUrlMock = vi.fn(async () => ({
  data: {
    path: 'user-1/upload.png',
    token: 'upload-token',
    signedUrl: 'https://storage.example.test/signed-upload',
  },
  error: null,
}));
const storageFromMock = vi.fn(() => ({
  createSignedUploadUrl: createSignedUploadUrlMock,
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

describe('/api/uploads/media/sign route', () => {
  beforeEach(() => {
    vi.resetModules();
    createUserClientMock.mockReset();
    createServiceClientFactory.mockClear();
    rpcMock.mockReset();
    rpcMock.mockResolvedValue({
      data: {
        allowed: true,
        limit: 60,
        remaining: 59,
        retryAfterSeconds: 0,
        resetAt: '2026-06-21T06:30:00.000Z',
      },
      error: null,
    });
    storageFromMock.mockClear();
    createSignedUploadUrlMock.mockReset();
    createSignedUploadUrlMock.mockResolvedValue({
      data: {
        path: 'user-1/upload.png',
        token: 'upload-token',
        signedUrl: 'https://storage.example.test/signed-upload',
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
    const { POST } = await import('@/app/api/uploads/media/sign/route');
    const response = await POST(
      new Request('http://localhost/api/uploads/media/sign', {
        method: 'POST',
      }) as never
    );

    expect(response.status).toBe(401);
    expect(createServiceClientFactory).not.toHaveBeenCalled();
  });

  it('creates a rate-limited signed upload token for owned temporary media paths', async () => {
    createUserClientMock.mockReturnValueOnce({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: 'user-1' } },
          error: null,
        })),
      },
    });

    const { POST } = await import('@/app/api/uploads/media/sign/route');
    const response = await POST(
      new Request('http://localhost/api/uploads/media/sign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: '../Launch Reference?.png',
          mimeType: 'image/png',
          kind: 'image',
          sizeBytes: 1234,
        }),
      }) as never
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      bucket: 'uploads',
      path: expect.stringMatching(/^user-1\/[0-9a-f-]+-launch-reference\.png$/),
      storagePath: expect.stringMatching(/^uploads\/user-1\/[0-9a-f-]+-launch-reference\.png$/),
      token: 'upload-token',
      signedUploadUrl: 'https://storage.example.test/signed-upload',
      expiresInSeconds: 7200,
    });
    expect(rpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'temporary-media-upload:sign',
      p_subject_key: 'user-1',
      p_limit: 60,
      p_window_seconds: 600,
    });
    expect(storageFromMock).toHaveBeenCalledWith('uploads');
    expect(createSignedUploadUrlMock).toHaveBeenCalledWith(
      expect.stringMatching(/^user-1\/[0-9a-f-]+-launch-reference\.png$/)
    );
  });

  it('rate limits upload token creation before storage signing work', async () => {
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
        limit: 60,
        remaining: 0,
        retryAfterSeconds: 44,
        resetAt: '2026-06-21T06:30:00.000Z',
      },
      error: null,
    });

    const { POST } = await import('@/app/api/uploads/media/sign/route');
    const response = await POST(
      new Request('http://localhost/api/uploads/media/sign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: 'reference.mp4',
          mimeType: 'video/mp4',
          kind: 'video',
          sizeBytes: 1234,
        }),
      }) as never
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('44');
    await expect(response.json()).resolves.toMatchObject({ code: 'RATE_LIMITED' });
    expect(storageFromMock).not.toHaveBeenCalled();
    expect(createSignedUploadUrlMock).not.toHaveBeenCalled();
  });
});
