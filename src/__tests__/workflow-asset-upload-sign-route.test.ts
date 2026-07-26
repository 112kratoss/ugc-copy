import { beforeEach, describe, expect, it, vi } from 'vitest';

const createUserClientMock = vi.fn();
const rpcMock = vi.fn(async (): Promise<{ data: unknown; error: unknown }> => ({
  data: {
    allowed: true,
    limit: 40,
    remaining: 39,
    retryAfterSeconds: 0,
    resetAt: '2026-06-22T06:30:00.000Z',
  },
  error: null,
}));
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

function expectPrivateNoStoreTraceHeaders(response: Response, requestId: string) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('x-request-id')).toBe(requestId);
}

describe('/api/uploads/workflow-asset/sign route', () => {
  beforeEach(() => {
    vi.resetModules();
    createUserClientMock.mockReset();
    createServiceClientFactory.mockClear();
    rpcMock.mockReset();
    rpcMock.mockResolvedValueOnce({ data: false, error: null });
    rpcMock.mockResolvedValue({
      data: {
        allowed: true,
        limit: 40,
        remaining: 39,
        retryAfterSeconds: 0,
        resetAt: '2026-06-22T06:30:00.000Z',
      },
      error: null,
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
    expect(storageFromMock).toHaveBeenCalledWith('generated_images');
    expect(createSignedUploadUrlMock).toHaveBeenCalledWith(
      expect.stringMatching(/^user-1\/workflow-input-[0-9a-f-]+-workflow-reference\.png$/)
    );
  });

  it('rejects a mismatched bucket and mime type before signing storage', async () => {
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
