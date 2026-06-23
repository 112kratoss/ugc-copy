import { beforeEach, describe, expect, it, vi } from 'vitest';

const createUserClientMock = vi.fn();
const rpcMock = vi.fn(async () => ({
  data: {
    allowed: true,
    limit: 80,
    remaining: 79,
    retryAfterSeconds: 0,
    resetAt: '2026-06-22T06:30:00.000Z',
  },
  error: null,
}));
const createSignedUrlMock = vi.fn(async () => ({
  data: {
    signedUrl: 'https://storage.example.test/signed/workflow-input.png',
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

function expectPrivateNoStoreTraceHeaders(response: Response, requestId: string) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('x-request-id')).toBe(requestId);
}

describe('/api/uploads/workflow-asset/read-url route', () => {
  beforeEach(() => {
    vi.resetModules();
    createUserClientMock.mockReset();
    createServiceClientFactory.mockClear();
    rpcMock.mockReset();
    rpcMock.mockResolvedValue({
      data: {
        allowed: true,
        limit: 80,
        remaining: 79,
        retryAfterSeconds: 0,
        resetAt: '2026-06-22T06:30:00.000Z',
      },
      error: null,
    });
    storageFromMock.mockClear();
    createSignedUrlMock.mockReset();
    createSignedUrlMock.mockResolvedValue({
      data: {
        signedUrl: 'https://storage.example.test/signed/workflow-input.png',
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
    const { POST } = await import('@/app/api/uploads/workflow-asset/read-url/route');
    const response = await POST(
      new Request('http://localhost/api/uploads/workflow-asset/read-url', {
        method: 'POST',
        headers: { 'x-request-id': 'workflow-asset-read-auth-1' },
      }) as never
    );

    expect(response.status).toBe(401);
    expectPrivateNoStoreTraceHeaders(response, 'workflow-asset-read-auth-1');
    expect(createServiceClientFactory).not.toHaveBeenCalled();
    expect(storageFromMock).not.toHaveBeenCalled();
    expect(createSignedUrlMock).not.toHaveBeenCalled();
  });

  it('creates a rate-limited read URL for an owned workflow asset path', async () => {
    createUserClientMock.mockReturnValueOnce({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: 'user-1' } },
          error: null,
        })),
      },
    });

    const { POST } = await import('@/app/api/uploads/workflow-asset/read-url/route');
    const response = await POST(
      new Request('http://localhost/api/uploads/workflow-asset/read-url', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'workflow-asset-read-success-1',
        },
        body: JSON.stringify({
          storagePath: 'generated_images/user-1/workflow-input-reference.png',
        }),
      }) as never
    );

    expect(response.status).toBe(200);
    expectPrivateNoStoreTraceHeaders(response, 'workflow-asset-read-success-1');
    await expect(response.json()).resolves.toEqual({
      success: true,
      signedUrl: 'https://storage.example.test/signed/workflow-input.png',
      expiresInSeconds: 3600,
    });
    expect(rpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'workflow-asset-upload:read-url',
      p_subject_key: 'user-1',
      p_limit: 80,
      p_window_seconds: 600,
    });
    expect(storageFromMock).toHaveBeenCalledWith('generated_images');
    expect(createSignedUrlMock).toHaveBeenCalledWith('user-1/workflow-input-reference.png', 3600);
  });

  it('rejects unowned or malformed workflow asset paths before storage signing work', async () => {
    createUserClientMock.mockReturnValueOnce({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: 'user-1' } },
          error: null,
        })),
      },
    });

    const { POST } = await import('@/app/api/uploads/workflow-asset/read-url/route');
    const response = await POST(
      new Request('http://localhost/api/uploads/workflow-asset/read-url', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'workflow-asset-read-forbidden-1',
        },
        body: JSON.stringify({
          storagePath: 'generated_images/user-2/workflow-input-reference.png',
        }),
      }) as never
    );

    expect(response.status).toBe(403);
    expectPrivateNoStoreTraceHeaders(response, 'workflow-asset-read-forbidden-1');
    await expect(response.json()).resolves.toEqual({
      error: 'Workflow asset path is not available.',
    });
    expect(storageFromMock).not.toHaveBeenCalled();
    expect(createSignedUrlMock).not.toHaveBeenCalled();
  });
});
