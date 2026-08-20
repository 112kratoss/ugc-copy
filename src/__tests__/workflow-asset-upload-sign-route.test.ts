import { beforeEach, describe, expect, it, vi } from 'vitest';

const createUserClientMock = vi.fn();
const requireIdentityMock = vi.hoisted(() => vi.fn());
const rpcMock = vi.fn();
const createSignedUploadUrlMock = vi.fn(async () => ({
  data: {
    path: 'user-1/workflow-input-reference.png',
    token: 'workflow-upload-token',
    signedUrl: 'https://storage.example.test/workflow-upload',
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

vi.mock('@/lib/account-identity', () => ({
  requireIdentity: (...args: unknown[]) => requireIdentityMock(...args),
}));

function expectPrivateNoStoreTraceHeaders(response: Response, requestId: string) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('x-request-id')).toBe(requestId);
}

describe('/api/uploads/workflow-asset/sign route', () => {
  beforeEach(() => {
    vi.resetModules();
    requireIdentityMock.mockReset();
    requireIdentityMock.mockResolvedValue({
      ok: false,
      status: 401,
      code: 'UNAUTHORIZED',
      error: 'Unauthorized',
    });
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
          allowed: true,
          limit: 40,
          remaining: 39,
          retryAfterSeconds: 0,
          resetAt: '2026-06-22T06:30:00.000Z',
        },
        error: null,
      };
    });
    storageFromMock.mockClear();
    createSignedUploadUrlMock.mockReset();
    createSignedUploadUrlMock.mockResolvedValue({
      data: {
        path: 'user-1/workflow-input-reference.png',
        token: 'workflow-upload-token',
        signedUrl: 'https://storage.example.test/workflow-upload',
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
    const { POST } = await import('@/app/api/uploads/workflow-asset/sign/route');
    const response = await POST(
      new Request('http://localhost/api/uploads/workflow-asset/sign', {
        method: 'POST',
        headers: { 'x-request-id': 'workflow-asset-sign-auth-1' },
      }) as never
    );

    expect(response.status).toBe(401);
    expectPrivateNoStoreTraceHeaders(response, 'workflow-asset-sign-auth-1');
    expect(createServiceClientFactory).not.toHaveBeenCalled();
  });

  it('creates a rate-limited signed upload token for a workflow image asset', async () => {
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

    const { POST } = await import('@/app/api/uploads/workflow-asset/sign/route');
    const response = await POST(
      new Request('http://localhost/api/uploads/workflow-asset/sign', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'workflow-asset-sign-success-1',
        },
        body: JSON.stringify({
          bucket: 'generated_images',
          fileName: '../Workflow Reference?.PNG',
          mimeType: 'image/png',
          sizeBytes: 1234,
        }),
      }) as never
    );

    expect(response.status).toBe(200);
    expectPrivateNoStoreTraceHeaders(response, 'workflow-asset-sign-success-1');
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      uploadId: expect.stringMatching(/^[0-9a-f-]+$/),
      bucket: 'generated_images',
      path: expect.stringMatching(/^user-1\/workflow-input-[0-9a-f-]+-workflow-reference\.png$/),
      storagePath: expect.stringMatching(/^generated_images\/user-1\/workflow-input-[0-9a-f-]+-workflow-reference\.png$/),
      token: 'workflow-upload-token',
      signedUploadUrl: 'https://storage.example.test/workflow-upload',
      expiresInSeconds: 7200,
    });
    expect(rpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'workflow-asset-upload:sign',
      p_subject_key: 'user-1',
      p_limit: 40,
      p_window_seconds: 600,
    });
    expect(rpcMock).toHaveBeenCalledWith('reserve_upload_bytes_v2', expect.objectContaining({
      p_bucket_id: 'generated_images',
      p_declared_bytes: 1234,
      p_expected_content_type: 'image/png',
      p_reserved_bytes: 25 * 1024 * 1024,
      p_user_id: 'user-1',
    }));
    expect(storageFromMock).toHaveBeenCalledWith('generated_images');
    expect(createSignedUploadUrlMock).toHaveBeenCalledWith(
      expect.stringMatching(/^user-1\/workflow-input-[0-9a-f-]+-workflow-reference\.png$/)
    );
  });

  it('rejects a mismatched bucket and mime type before signing storage', async () => {
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

    const { POST } = await import('@/app/api/uploads/workflow-asset/sign/route');
    const response = await POST(
      new Request('http://localhost/api/uploads/workflow-asset/sign', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'workflow-asset-sign-validation-1',
        },
        body: JSON.stringify({
          bucket: 'generated_audio',
          fileName: 'clip.mp4',
          mimeType: 'video/mp4',
          sizeBytes: 1234,
        }),
      }) as never
    );

    expect(response.status).toBe(400);
    expectPrivateNoStoreTraceHeaders(response, 'workflow-asset-sign-validation-1');
    await expect(response.json()).resolves.toMatchObject({
      error: 'Upload a valid audio file.',
    });
    expect(storageFromMock).not.toHaveBeenCalled();
    expect(createSignedUploadUrlMock).not.toHaveBeenCalled();
  });
});
