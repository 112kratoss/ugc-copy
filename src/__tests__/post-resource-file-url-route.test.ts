import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const getPostResourceBundleDetailByPostIdMock = vi.hoisted(() => vi.fn());
const createSignedUrlMock = vi.hoisted(() => vi.fn());
const storageFromMock = vi.hoisted(() => vi.fn());
const createServiceClientMock = vi.hoisted(() => vi.fn());
const rpcMock = vi.hoisted(() => vi.fn());
const authState = vi.hoisted(() => ({
  user: { id: 'buyer-1' } as { id: string } | null,
}));

vi.mock('@/lib/post-resource-bundles-server', () => ({
  getPostResourceBundleDetailByPostId: getPostResourceBundleDetailByPostIdMock,
}));

vi.mock('@/lib/server-helpers', () => ({
  createUserClient: () => ({
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: authState.user },
        error: null,
      })),
    },
  }),
  createServiceClient: () => createServiceClientMock(),
}));

function expectPrivateNoStoreTraceHeaders(response: Response, requestId: string) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('x-request-id')).toBe(requestId);
}

function buildRequest(storagePath: string, requestId = 'resource-file-url-1') {
  return new Request('http://localhost/api/posts/post-1/resource-bundle/file-url', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer token',
      'x-request-id': requestId,
    },
    body: JSON.stringify({ storagePath }),
  }) as NextRequest;
}

describe('/api/posts/[postId]/resource-bundle/file-url route', () => {
  beforeEach(() => {
    vi.resetModules();
    authState.user = { id: 'buyer-1' };
    getPostResourceBundleDetailByPostIdMock.mockReset();
    createSignedUrlMock.mockReset();
    storageFromMock.mockReset();
    createServiceClientMock.mockReset();
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
    createServiceClientMock.mockReturnValue({
      rpc: rpcMock,
      storage: {
        from: storageFromMock.mockImplementation(() => ({
          createSignedUrl: createSignedUrlMock,
        })),
      },
    });
    createSignedUrlMock.mockResolvedValue({
      data: {
        signedUrl: 'https://signed.example.com/reference.png',
      },
      error: null,
    });
  });

  it('does not create an admin client when no resource path is provided', async () => {
    const { POST } = await import('@/app/api/posts/[postId]/resource-bundle/file-url/route');
    const response = await POST(
      new Request('http://localhost/api/posts/post-1/resource-bundle/file-url', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'resource-file-missing-path-1',
        },
        body: JSON.stringify({}),
      }) as NextRequest,
      { params: Promise.resolve({ postId: 'post-1' }) }
    );
    const data = await response.json();

    expect(response.status).toBe(400);
    expectPrivateNoStoreTraceHeaders(response, 'resource-file-missing-path-1');
    expect(data.error).toBe('Missing resource file path.');
    expect(createServiceClientMock).not.toHaveBeenCalled();
    expect(getPostResourceBundleDetailByPostIdMock).not.toHaveBeenCalled();
    expect(createSignedUrlMock).not.toHaveBeenCalled();
  });

  it('signs copied reference files for anonymous viewers when the recipe is public', async () => {
    authState.user = null;
    getPostResourceBundleDetailByPostIdMock.mockResolvedValue({
      viewerCanAccess: true,
      seller: { id: 'user-1' },
      resources: {
        attachments: [],
        items: [{
          title: 'Public reference',
          storagePath: 'user-1/generation-references/gen-1/public-reference.png',
        }],
      },
    });

    const { POST } = await import('@/app/api/posts/[postId]/resource-bundle/file-url/route');
    const response = await POST(
      buildRequest('user-1/generation-references/gen-1/public-reference.png'),
      { params: Promise.resolve({ postId: 'post-1' }) }
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expectPrivateNoStoreTraceHeaders(response, 'resource-file-url-1');
    expect(data.signedUrl).toBe('https://signed.example.com/reference.png');
    expect(getPostResourceBundleDetailByPostIdMock).toHaveBeenCalledWith('post-1', expect.objectContaining({
      viewerUserId: null,
    }));
    expect(rpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'post-resource-file:read-url',
      p_subject_key: '127.0.0.1',
      p_limit: 120,
      p_window_seconds: 600,
    });
    expect(storageFromMock).toHaveBeenCalledWith('post_resource_files');
  });

  it('signs public generation input recipe references from the generation input bucket', async () => {
    authState.user = null;
    getPostResourceBundleDetailByPostIdMock.mockResolvedValue({
      viewerCanAccess: true,
      seller: { id: 'user-1' },
      resources: {
        attachments: [],
        items: [{
          title: 'Image input',
          storagePath: 'generation_inputs/user-1/gen-1/00-reference-image.png',
        }],
      },
    });

    const { POST } = await import('@/app/api/posts/[postId]/resource-bundle/file-url/route');
    const response = await POST(
      buildRequest('generation_inputs/user-1/gen-1/00-reference-image.png'),
      { params: Promise.resolve({ postId: 'post-1' }) }
    );

    expect(response.status).toBe(200);
    expect(storageFromMock).toHaveBeenCalledWith('generation_inputs');
    expect(createSignedUrlMock).toHaveBeenCalledWith(
      'user-1/gen-1/00-reference-image.png',
      600,
      expect.objectContaining({
        download: 'Image input',
      })
    );
  });

  it('signs public legacy upload recipe references from the uploads bucket', async () => {
    authState.user = null;
    getPostResourceBundleDetailByPostIdMock.mockResolvedValue({
      viewerCanAccess: true,
      seller: { id: 'user-1' },
      resources: {
        attachments: [],
        items: [{
          title: 'Element 1',
          storagePath: 'uploads/user-1/legacy-reference.jpeg',
        }],
      },
    });

    const { POST } = await import('@/app/api/posts/[postId]/resource-bundle/file-url/route');
    const response = await POST(
      buildRequest('uploads/user-1/legacy-reference.jpeg'),
      { params: Promise.resolve({ postId: 'post-1' }) }
    );

    expect(response.status).toBe(200);
    expect(storageFromMock).toHaveBeenCalledWith('uploads');
    expect(createSignedUrlMock).toHaveBeenCalledWith(
      'user-1/legacy-reference.jpeg',
      600,
      expect.objectContaining({
        download: 'Element 1',
      })
    );
  });

  it('blocks locked buyers from fetching copied reference file URLs', async () => {
    getPostResourceBundleDetailByPostIdMock.mockResolvedValue({
      viewerCanAccess: false,
      resources: null,
    });

    const { POST } = await import('@/app/api/posts/[postId]/resource-bundle/file-url/route');
    const response = await POST(
      buildRequest('user-1/generation-references/gen-1/00-reference-image-input-1.png'),
      { params: Promise.resolve({ postId: 'post-1' }) }
    );
    const data = await response.json();

    expect(response.status).toBe(403);
    expectPrivateNoStoreTraceHeaders(response, 'resource-file-url-1');
    expect(data.error).toBe('Unlock this resource before downloading files.');
    expect(createSignedUrlMock).not.toHaveBeenCalled();
  });

  it('signs copied reference files after the buyer has access', async () => {
    getPostResourceBundleDetailByPostIdMock.mockResolvedValue({
      viewerCanAccess: true,
      seller: { id: 'user-1' },
      resources: {
        attachments: [],
        items: [{
          title: 'Hero reference',
          storagePath: 'user-1/generation-references/gen-1/00-reference-image-input-1.png',
        }],
      },
    });

    const { POST } = await import('@/app/api/posts/[postId]/resource-bundle/file-url/route');
    const response = await POST(
      buildRequest('user-1/generation-references/gen-1/00-reference-image-input-1.png'),
      { params: Promise.resolve({ postId: 'post-1' }) }
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.signedUrl).toBe('https://signed.example.com/reference.png');
    expect(getPostResourceBundleDetailByPostIdMock).toHaveBeenCalledWith('post-1', expect.objectContaining({
      viewerUserId: 'buyer-1',
    }));
    expect(rpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'post-resource-file:read-url',
      p_subject_key: 'buyer-1',
      p_limit: 120,
      p_window_seconds: 600,
    });
    expect(createSignedUrlMock).toHaveBeenCalledWith(
      'user-1/generation-references/gen-1/00-reference-image-input-1.png',
      600,
      expect.objectContaining({
        download: 'Hero reference',
      })
    );
  });

  it('rate limits resource file URL signing before minting a storage URL', async () => {
    rpcMock.mockResolvedValue({
      data: {
        allowed: false,
        limit: 120,
        remaining: 0,
        retryAfterSeconds: 18,
        resetAt: '2026-06-22T06:30:00.000Z',
      },
      error: null,
    });
    getPostResourceBundleDetailByPostIdMock.mockResolvedValue({
      viewerCanAccess: true,
      seller: { id: 'user-1' },
      resources: {
        attachments: [],
        items: [{
          title: 'Hero reference',
          storagePath: 'user-1/generation-references/gen-1/00-reference-image-input-1.png',
        }],
      },
    });

    const { POST } = await import('@/app/api/posts/[postId]/resource-bundle/file-url/route');
    const response = await POST(
      buildRequest('user-1/generation-references/gen-1/00-reference-image-input-1.png'),
      { params: Promise.resolve({ postId: 'post-1' }) }
    );
    const data = await response.json();

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('18');
    expectPrivateNoStoreTraceHeaders(response, 'resource-file-url-1');
    expect(data).toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 18,
    });
    expect(createSignedUrlMock).not.toHaveBeenCalled();
  });
});
