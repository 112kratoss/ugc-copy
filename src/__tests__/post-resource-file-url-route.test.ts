import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const getPostResourceBundleDetailByPostIdMock = vi.hoisted(() => vi.fn());
const createSignedUrlMock = vi.hoisted(() => vi.fn());
const storageFromMock = vi.hoisted(() => vi.fn());
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
  createServiceClient: () => ({
    storage: {
      from: storageFromMock.mockImplementation(() => ({
        createSignedUrl: createSignedUrlMock,
      })),
    },
  }),
}));

function buildRequest(storagePath: string) {
  return new Request('http://localhost/api/posts/post-1/resource-bundle/file-url', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer token',
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
    createSignedUrlMock.mockResolvedValue({
      data: {
        signedUrl: 'https://signed.example.com/reference.png',
      },
      error: null,
    });
  });

  it('signs copied reference files for anonymous viewers when the recipe is public', async () => {
    authState.user = null;
    getPostResourceBundleDetailByPostIdMock.mockResolvedValue({
      viewerCanAccess: true,
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
    expect(data.signedUrl).toBe('https://signed.example.com/reference.png');
    expect(getPostResourceBundleDetailByPostIdMock).toHaveBeenCalledWith('post-1', expect.objectContaining({
      viewerUserId: null,
    }));
    expect(storageFromMock).toHaveBeenCalledWith('post_resource_files');
  });

  it('signs public generation input recipe references from the generation input bucket', async () => {
    authState.user = null;
    getPostResourceBundleDetailByPostIdMock.mockResolvedValue({
      viewerCanAccess: true,
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
    expect(data.error).toBe('Unlock this resource before downloading files.');
    expect(createSignedUrlMock).not.toHaveBeenCalled();
  });

  it('signs copied reference files after the buyer has access', async () => {
    getPostResourceBundleDetailByPostIdMock.mockResolvedValue({
      viewerCanAccess: true,
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
    expect(createSignedUrlMock).toHaveBeenCalledWith(
      'user-1/generation-references/gen-1/00-reference-image-input-1.png',
      600,
      expect.objectContaining({
        download: 'Hero reference',
      })
    );
  });
});
