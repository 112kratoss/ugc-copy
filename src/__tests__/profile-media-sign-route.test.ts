import { beforeEach, describe, expect, it, vi } from 'vitest';

const createUserClientMock = vi.fn();
const rpcMock = vi.fn(async (_fn?: string): Promise<{ data: unknown; error: unknown }> => {
  void _fn;
  return {
    data: {
      allowed: true,
      limit: 30,
      remaining: 29,
      retryAfterSeconds: 0,
      resetAt: '2026-06-21T06:30:00.000Z',
    },
    error: null,
  };
});
const createSignedUploadUrlMock = vi.fn(async () => ({
  data: {
    token: 'profile-upload-token',
    signedUrl: 'https://storage.example.test/profile-upload-token',
  },
  error: null,
}));
const getPublicUrlMock = vi.fn((filePath: string) => ({
  data: {
    publicUrl: `https://storage.example.test/profiles/${filePath}`,
  },
}));
const storageFromMock = vi.fn(() => ({
  createSignedUploadUrl: createSignedUploadUrlMock,
  getPublicUrl: getPublicUrlMock,
}));
const adminClient = {
  rpc: rpcMock,
  from(table: string) {
    if (table !== 'profiles') throw new Error(`Unexpected table: ${table}`);
    const query = {
      select() { return query; },
      eq() { return query; },
      async maybeSingle() {
        return { data: { identity_state: 'active' }, error: null };
      },
    };
    return query;
  },
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

describe('/api/profile/media/sign route', () => {
  beforeEach(() => {
    vi.resetModules();
    createUserClientMock.mockReset();
    createServiceClientFactory.mockClear();
    rpcMock.mockReset();
    rpcMock.mockImplementation(async (fn?: string) => {
      if (fn === 'is_account_deletion_requested') return { data: false, error: null };
      if (fn === 'reserve_upload_bytes_v2') return { data: { allowed: true }, error: null };
      if (fn === 'mark_upload_byte_reservation_issued') return { data: true, error: null };
      return {
        data: {
          allowed: true,
          limit: 30,
          remaining: 29,
          retryAfterSeconds: 0,
          resetAt: '2026-06-21T06:30:00.000Z',
        },
        error: null,
      };
    });
    storageFromMock.mockClear();
    createSignedUploadUrlMock.mockReset();
    createSignedUploadUrlMock.mockResolvedValue({
      data: {
        token: 'profile-upload-token',
        signedUrl: 'https://storage.example.test/profile-upload-token',
      },
      error: null,
    });
    getPublicUrlMock.mockClear();
    getPublicUrlMock.mockImplementation((filePath: string) => ({
      data: {
        publicUrl: `https://storage.example.test/profiles/${filePath}`,
      },
    }));
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
    const { POST } = await import('@/app/api/profile/media/sign/route');
    const response = await POST(
      new Request('http://localhost/api/profile/media/sign', {
        method: 'POST',
        headers: { 'x-request-id': 'profile-media-sign-auth-1' },
      }) as never
    );

    expect(response.status).toBe(401);
    expectPrivateNoStoreTraceHeaders(response, 'profile-media-sign-auth-1');
    expect(createServiceClientFactory).not.toHaveBeenCalled();
  });

  it('creates a rate-limited signed profile upload token and public URL', async () => {
    createUserClientMock.mockReturnValueOnce({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: 'user-1' } },
          error: null,
        })),
      },
    });

    const { POST } = await import('@/app/api/profile/media/sign/route');
    const response = await POST(
      new Request('http://localhost/api/profile/media/sign', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'profile-media-sign-success-1',
        },
        body: JSON.stringify({
          role: 'avatar',
          fileName: '../Avatar Photo?.png',
          mimeType: 'image/png',
          sizeBytes: 1234,
        }),
      }) as never
    );

    expect(response.status).toBe(200);
    expectPrivateNoStoreTraceHeaders(response, 'profile-media-sign-success-1');
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      bucket: 'profiles',
      path: expect.stringMatching(/^user-1\/avatar-[0-9a-f-]+-avatar-photo\.png$/),
      publicUrl: expect.stringMatching(/^https:\/\/storage\.example\.test\/profiles\/user-1\/avatar-[0-9a-f-]+-avatar-photo\.png$/),
      token: 'profile-upload-token',
      signedUploadUrl: 'https://storage.example.test/profile-upload-token',
      expiresInSeconds: 7200,
    });
    expect(rpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'profile-media-upload:sign',
      p_subject_key: 'user-1',
      p_limit: 30,
      p_window_seconds: 600,
    });
    expect(storageFromMock).toHaveBeenCalledWith('profiles');
    expect(createSignedUploadUrlMock).toHaveBeenCalledWith(
      expect.stringMatching(/^user-1\/avatar-[0-9a-f-]+-avatar-photo\.png$/)
    );
  });

  it('rate limits profile upload token creation before storage signing work', async () => {
    createUserClientMock.mockReturnValueOnce({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: 'user-1' } },
          error: null,
        })),
      },
    });
    rpcMock.mockImplementation(async (fn?: string) => {
      if (fn === 'is_account_deletion_requested') return { data: false, error: null };
      return {
        data: {
          allowed: false,
          limit: 30,
          remaining: 0,
          retryAfterSeconds: 45,
          resetAt: '2026-06-21T06:30:00.000Z',
        },
        error: null,
      };
    });

    const { POST } = await import('@/app/api/profile/media/sign/route');
    const response = await POST(
      new Request('http://localhost/api/profile/media/sign', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'profile-media-sign-rate-limit-1',
        },
        body: JSON.stringify({
          role: 'cover',
          fileName: 'cover.jpg',
          mimeType: 'image/jpeg',
          sizeBytes: 1234,
        }),
      }) as never
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('45');
    expectPrivateNoStoreTraceHeaders(response, 'profile-media-sign-rate-limit-1');
    await expect(response.json()).resolves.toMatchObject({ code: 'RATE_LIMITED' });
    expect(storageFromMock).not.toHaveBeenCalled();
    expect(createSignedUploadUrlMock).not.toHaveBeenCalled();
    expect(getPublicUrlMock).not.toHaveBeenCalled();
  });
});
