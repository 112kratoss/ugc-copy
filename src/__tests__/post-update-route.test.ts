import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const getMarketplaceQualityErrorForPostBundleMock = vi.hoisted(() => vi.fn());
const updatePostWithResourceBundleAtomicallyMock = vi.hoisted(() => vi.fn());
const createServiceClientMock = vi.hoisted(() => vi.fn());
const sourceToolTableCalls = vi.hoisted(() => ({
  rpcCalls: [] as Array<Record<string, unknown>>,
  rpcError: null as { message?: string } | null,
}));
const postMediaRows = vi.hoisted(() => ({
  value: [
    {
      id: 'media-1',
      storage_path: 'posts/post-1/cover.jpg',
      external_url: null,
      media_kind: 'image',
      content_type: 'image/jpeg',
      original_name: 'cover.jpg',
      width: 800,
      height: 1000,
      duration_seconds: null,
      sort_order: 0,
    },
    {
      id: 'media-2',
      storage_path: 'posts/post-1/second.jpg',
      external_url: null,
      media_kind: 'image',
      content_type: 'image/jpeg',
      original_name: 'second.jpg',
      width: 1200,
      height: 800,
      duration_seconds: null,
      sort_order: 1,
    },
  ],
}));
const sourceToolCatalog = vi.hoisted(() => [
  { slug: 'magicbooklet', label: 'magicbooklet', models: [], supportedMediaKinds: ['image', 'video'] },
  { slug: 'higgsfield', label: 'Higgsfield', models: [{ slug: 'soul', label: 'Soul' }], supportedMediaKinds: ['image', 'video'] },
]);
type LoadedPostMock = {
  id: string;
  user_id: string;
  generation_id: string | null;
  visibility: 'public' | 'unlisted' | 'private';
  title: string;
  description: string | null;
  body: string;
  category: string;
  post_format: 'text' | 'media' | 'mixed';
  source_tool: string | null;
  source_tool_slug: string | null;
  source_kind: string;
  archived_at: string | null;
  showcase_asset_path: string | null;
  output_url: string | null;
  review_status: string;
};
const loadedPost = vi.hoisted((): { value: LoadedPostMock } => ({
  value: {
    id: 'post-1',
    user_id: 'user-1',
    generation_id: null,
    visibility: 'private',
    title: 'Draft post',
    description: null,
    body: 'A draft post with an unlock package.',
    category: 'text',
    post_format: 'text',
    source_tool: null,
    source_tool_slug: null,
    source_kind: 'manual',
    archived_at: null,
    showcase_asset_path: null,
    output_url: null,
    review_status: 'visible',
  },
}));
const loadedBundle = vi.hoisted(() => ({
  value: {
    access_mode: 'paid',
    status: 'draft',
  },
}));

vi.mock('@/lib/server-helpers', () => ({
  createUserClient: () => ({
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: 'user-1' } },
        error: null,
      })),
    },
  }),
  createServiceClient: () => {
    createServiceClientMock();

    return {
    from(table: string) {
      if (table === 'posts') {
        const query = {
          select() {
            return query;
          },
          eq() {
            return query;
          },
          async maybeSingle() {
            return {
              data: loadedPost.value,
              error: null,
            };
          },
        };

        return query;
      }

      if (table === 'post_resource_bundles') {
        const query = {
          select() {
            return query;
          },
          eq() {
            return query;
          },
          async maybeSingle() {
            return {
              data: loadedBundle.value,
              error: null,
            };
          },
        };

        return query;
      }

      if (table === 'post_media') {
        const query = {
          select() {
            return query;
          },
          eq() {
            return query;
          },
          async order() {
            return {
              data: postMediaRows.value,
              error: null,
            };
          },
        };

        return query;
      }

      throw new Error(`Unexpected table access: ${table}`);
    },
    rpc(name: string, args: Record<string, unknown>) {
      if (name !== 'save_post_source_tools_with_catalog' && name !== 'replace_post_media') {
        throw new Error(`Unexpected rpc call: ${name}`);
      }
      sourceToolTableCalls.rpcCalls.push(args);
      return Promise.resolve({ data: null, error: sourceToolTableCalls.rpcError });
    },
    };
  },
}));

vi.mock('@/lib/post-resource-bundles-server', () => ({
  getMarketplaceQualityErrorForPostBundle: getMarketplaceQualityErrorForPostBundleMock,
  updatePostWithResourceBundleAtomically: updatePostWithResourceBundleAtomicallyMock,
}));

vi.mock('@/lib/source-tools-server', () => ({
  listSourceToolsCatalog: () => Promise.resolve(sourceToolCatalog),
}));

describe('/api/posts/[postId] route', () => {
  beforeEach(() => {
    vi.resetModules();
    loadedPost.value = {
      id: 'post-1',
      user_id: 'user-1',
      generation_id: null,
      visibility: 'private',
      title: 'Draft post',
      description: null,
      body: 'A draft post with an unlock package.',
      category: 'text',
      post_format: 'text',
      source_tool: null,
      source_tool_slug: null,
      source_kind: 'manual',
      archived_at: null,
      showcase_asset_path: null,
      output_url: null,
      review_status: 'visible',
    };
    loadedBundle.value = {
      access_mode: 'paid',
      status: 'draft',
    };
    getMarketplaceQualityErrorForPostBundleMock.mockReset();
    getMarketplaceQualityErrorForPostBundleMock.mockResolvedValue('Quality should not run for private draft unlocks.');
    createServiceClientMock.mockReset();
    updatePostWithResourceBundleAtomicallyMock.mockReset();
    updatePostWithResourceBundleAtomicallyMock.mockImplementation(async ({ patch }) => ({
      postId: 'post-1',
      visibility: patch.visibility,
      bundleId: 'bundle-1',
      bundleStatus: patch.visibility === 'public' ? 'published' : 'draft',
    }));
    sourceToolTableCalls.rpcCalls.length = 0;
    sourceToolTableCalls.rpcError = null;
    postMediaRows.value = [
      {
        id: 'media-1',
        storage_path: 'posts/post-1/cover.jpg',
        external_url: null,
        media_kind: 'image',
        content_type: 'image/jpeg',
        original_name: 'cover.jpg',
        width: 800,
        height: 1000,
        duration_seconds: null,
        sort_order: 0,
      },
      {
        id: 'media-2',
        storage_path: 'posts/post-1/second.jpg',
        external_url: null,
        media_kind: 'image',
        content_type: 'image/jpeg',
        original_name: 'second.jpg',
        width: 1200,
        height: 800,
        duration_seconds: null,
        sort_order: 1,
      },
    ];
  });

  it('updates private posts with draft unlock bundles without marketplace quality gating', async () => {
    const { PUT } = await import('@/app/api/posts/[postId]/route');
    const response = await PUT(new Request('http://localhost/api/posts/post-1', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token',
      },
      body: JSON.stringify({
        title: 'Helpful launch proof',
        body: 'A draft post with an unlock package.',
        visibility: 'private',
        resourceBundle: {
          accessMode: 'paid',
          summary: 'A reusable launch prompt for a proof-led product hook.',
          previewText: 'Includes the prompt structure and CTA guidance buyers can reuse.',
          priceUsdCents: 500,
          resources: {
            promptText: 'Use a before and after hook with one product proof frame and a short CTA.',
            attachments: [],
            allowRemix: false,
          },
        },
      }),
    }) as NextRequest, {
      params: Promise.resolve({ postId: 'post-1' }),
    });

    const data = await response.json();

    expect(response.status).toBe(200);
    expect(getMarketplaceQualityErrorForPostBundleMock).not.toHaveBeenCalled();
    expect(updatePostWithResourceBundleAtomicallyMock).toHaveBeenCalledWith(expect.objectContaining({
      patch: expect.objectContaining({
        visibility: 'private',
      }),
      hasBundlePayload: true,
    }));
    expect(data.visibility).toBe('private');
    expect(data.resourceBundleStatus).toBe('draft');
    expect(data.resourceBundlePath).toBe('/post/post-1/edit#resources');
  });

  it('reuses a single admin client while updating an owner post', async () => {
    const { PUT } = await import('@/app/api/posts/[postId]/route');
    const response = await PUT(new Request('http://localhost/api/posts/post-1', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token',
      },
      body: JSON.stringify({
        title: 'Helpful launch proof',
        visibility: 'private',
        resourceBundle: { accessMode: 'none' },
      }),
    }) as NextRequest, {
      params: Promise.resolve({ postId: 'post-1' }),
    });

    expect(response.status).toBe(200);
    expect(createServiceClientMock).toHaveBeenCalledTimes(1);
  });

  it('publishes draft unlocks when the request includes the bundle payload', async () => {
    getMarketplaceQualityErrorForPostBundleMock.mockResolvedValue(null);

    const { PUT } = await import('@/app/api/posts/[postId]/route');
    const response = await PUT(new Request('http://localhost/api/posts/post-1', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token',
      },
      body: JSON.stringify({
        title: 'Helpful launch proof',
        body: 'A public proof post with a complete unlock package.',
        visibility: 'public',
        resourceBundle: {
          accessMode: 'paid',
          summary: 'A reusable launch prompt for a proof-led product hook.',
          previewText: 'Includes the prompt structure and CTA guidance buyers can reuse.',
          priceUsdCents: 500,
          resources: {
            promptText: 'Use a before and after hook with one product proof frame and a short CTA.',
            attachments: [],
            allowRemix: false,
          },
        },
      }),
    }) as NextRequest, {
      params: Promise.resolve({ postId: 'post-1' }),
    });

    const data = await response.json();

    expect(response.status).toBe(200);
    expect(getMarketplaceQualityErrorForPostBundleMock).toHaveBeenCalledTimes(1);
    expect(updatePostWithResourceBundleAtomicallyMock).toHaveBeenCalledWith(expect.objectContaining({
      patch: expect.objectContaining({
        visibility: 'public',
      }),
      hasBundlePayload: true,
    }));
    expect(data.visibility).toBe('public');
    expect(data.resourceBundleStatus).toBe('published');
    expect(data.resourceBundlePath).toBe('/showcase/post-1#resources');
  });

  it('rejects publishing a draft unlock without resubmitting the bundle payload', async () => {
    const { PUT } = await import('@/app/api/posts/[postId]/route');
    const response = await PUT(new Request('http://localhost/api/posts/post-1', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token',
      },
      body: JSON.stringify({
        title: 'Helpful launch proof',
        body: 'A public proof post with a complete unlock package.',
        visibility: 'public',
      }),
    }) as NextRequest, {
      params: Promise.resolve({ postId: 'post-1' }),
    });

    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toMatch(/resubmit/i);
    expect(data.error).toMatch(/unlock/i);
    expect(getMarketplaceQualityErrorForPostBundleMock).not.toHaveBeenCalled();
    expect(updatePostWithResourceBundleAtomicallyMock).not.toHaveBeenCalled();
  });

  it('rejects source tool updates for generation-backed posts', async () => {
    loadedPost.value = {
      ...loadedPost.value,
      generation_id: 'generation-1',
    };

    const { PUT } = await import('@/app/api/posts/[postId]/route');
    const response = await PUT(new Request('http://localhost/api/posts/post-1', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token',
      },
      body: JSON.stringify({
        sourceTools: [{
          toolLabel: 'Runway',
          toolSlug: 'runway',
          modelLabel: 'Gen-4',
          modelSlug: 'gen-4',
        }],
      }),
    }) as NextRequest, {
      params: Promise.resolve({ postId: 'post-1' }),
    });

    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toMatch(/generation-backed posts/i);
    expect(updatePostWithResourceBundleAtomicallyMock).not.toHaveBeenCalled();
    expect(sourceToolTableCalls.rpcCalls).toHaveLength(0);
  });

  it('returns an error when replacing source tools fails', async () => {
    sourceToolTableCalls.rpcError = { message: 'source tools insert failed' };

    const { PUT } = await import('@/app/api/posts/[postId]/route');
    const response = await PUT(new Request('http://localhost/api/posts/post-1', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token',
      },
      body: JSON.stringify({
        title: 'Updated title',
        visibility: 'private',
        sourceTools: [{
          toolLabel: 'Runway',
          toolSlug: 'runway',
          modelLabel: 'Gen-4',
          modelSlug: 'gen-4',
        }],
      }),
    }) as NextRequest, {
      params: Promise.resolve({ postId: 'post-1' }),
    });

    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.error).toMatch(/source tool/i);
  });

  it('reorders existing post media and promotes the first item to cover', async () => {
    loadedPost.value = {
      ...loadedPost.value,
      body: '',
      category: 'image',
      post_format: 'media',
      showcase_asset_path: 'posts/post-1/cover.jpg',
    };

    const { PUT } = await import('@/app/api/posts/[postId]/route');
    const response = await PUT(new Request('http://localhost/api/posts/post-1', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token',
      },
      body: JSON.stringify({
        visibility: 'private',
        mediaItems: [
          { existingId: 'media-2' },
          { existingId: 'media-1' },
        ],
        resourceBundle: { accessMode: 'none' },
      }),
    }) as NextRequest, {
      params: Promise.resolve({ postId: 'post-1' }),
    });

    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(sourceToolTableCalls.rpcCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        p_post_id: 'post-1',
        p_owner_user_id: 'user-1',
        p_media_items: [
          expect.objectContaining({ storagePath: 'posts/post-1/second.jpg', sortOrder: 0 }),
          expect.objectContaining({ storagePath: 'posts/post-1/cover.jpg', sortOrder: 1 }),
        ],
      }),
    ]));
  });
});
