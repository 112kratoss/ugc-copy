import { beforeEach, describe, expect, it, vi } from 'vitest';

import mobileApiContract from '../../contracts/mobile-api-v1.json';

const createUserClientMock = vi.fn();
const requireIdentityMock = vi.hoisted(() => vi.fn());
const rpcMock = vi.fn();
let mediaSignRateAllowed = true;
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
const intentInsertMock = vi.fn(async () => ({ error: null }));
const tableFromMock = vi.fn(() => ({ insert: intentInsertMock }));
const adminClient = {
  rpc: rpcMock,
  from: tableFromMock,
  storage: {
    from: storageFromMock,
  },
};
const createServiceClientFactory = vi.fn(() => adminClient);

vi.mock('@/lib/server-helpers', () => ({
  createUserClient: (request: Request) => createUserClientMock(request),
  createServiceClient: () => createServiceClientFactory(),
}));

vi.mock('@/lib/account-identity', () => ({
  requireIdentity: (...args: unknown[]) => requireIdentityMock(...args),
}));

describe('/api/uploads/media/sign route', () => {
  beforeEach(() => {
    vi.resetModules();
    requireIdentityMock.mockReset();
    requireIdentityMock.mockResolvedValue({
      ok: false,
      status: 401,
      code: 'UNAUTHORIZED',
      error: 'Unauthorized',
    });
    mediaSignRateAllowed = true;
    createUserClientMock.mockReset();
    createServiceClientFactory.mockClear();
    rpcMock.mockReset();
    rpcMock.mockImplementation(async (fn: string) => {
      if (fn === 'is_account_deletion_requested') return { data: false, error: null };
      if (fn === 'reserve_upload_bytes_v2') return { data: { allowed: true }, error: null };
      if (
        fn === 'mark_upload_byte_reservation_issued'
        || fn === 'abort_upload_byte_reservation_before_issue'
      ) return { data: true, error: null };
      return {
        data: {
          allowed: mediaSignRateAllowed,
          limit: 60,
          remaining: mediaSignRateAllowed ? 59 : 0,
          retryAfterSeconds: mediaSignRateAllowed ? 0 : 44,
          resetAt: '2026-06-21T06:30:00.000Z',
        },
        error: null,
      };
    });
    storageFromMock.mockClear();
    tableFromMock.mockClear();
    intentInsertMock.mockClear();
    intentInsertMock.mockResolvedValue({ error: null });
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
        headers: {
          authorization: 'Bearer private-token',
          'x-request-id': 'media-sign-auth-1',
        },
      }) as never
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('media-sign-auth-1');
    expect(response.headers.has('authorization')).toBe(false);
    expect(Array.from(response.headers.entries()).join('\n')).not.toContain('private-token');
    expect(createServiceClientFactory).not.toHaveBeenCalled();
  });

  it('creates a rate-limited signed upload token for owned temporary media paths', async () => {
    requireIdentityMock.mockResolvedValueOnce({
      ok: true,
      identity: {
        user: { id: 'user-1', is_anonymous: false },
        userId: 'user-1',
        kind: 'registered',
        isGuest: false,
      },
    });
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
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'media-sign-success-1',
        },
        body: JSON.stringify({
          fileName: '../Launch Reference?.png',
          mimeType: 'image/png',
          kind: 'image',
          sizeBytes: 1234,
        }),
      }) as never
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('media-sign-success-1');
    const body = await response.json();
    expect(body).toMatchObject({
      success: mobileApiContract.endpoints.mediaUploadIntent.response.success,
      bucket: mobileApiContract.endpoints.mediaUploadIntent.response.bucket,
      path: expect.stringMatching(/^user-1\/[0-9a-f-]+-launch-reference\.png$/),
      storagePath: expect.stringMatching(/^uploads\/user-1\/[0-9a-f-]+-launch-reference\.png$/),
      token: mobileApiContract.endpoints.mediaUploadIntent.response.token,
      signedUploadUrl: mobileApiContract.endpoints.mediaUploadIntent.response.signedUploadUrl,
      expiresInSeconds: mobileApiContract.endpoints.mediaUploadIntent.response.expiresInSeconds,
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
    requireIdentityMock.mockResolvedValueOnce({
      ok: true,
      identity: {
        user: { id: 'user-1', is_anonymous: false },
        userId: 'user-1',
        kind: 'registered',
        isGuest: false,
      },
    });
    createUserClientMock.mockReturnValueOnce({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: 'user-1' } },
          error: null,
        })),
      },
    });
    mediaSignRateAllowed = false;

    const { POST } = await import('@/app/api/uploads/media/sign/route');
    const response = await POST(
      new Request('http://localhost/api/uploads/media/sign', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'media-sign-rate-limit-1',
        },
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
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('media-sign-rate-limit-1');
    await expect(response.json()).resolves.toMatchObject({ code: 'RATE_LIMITED' });
    expect(storageFromMock).not.toHaveBeenCalled();
    expect(createSignedUploadUrlMock).not.toHaveBeenCalled();
  });
});
