import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const getMarketplaceQualityErrorForPostBundleMock = vi.hoisted(() => vi.fn());
const updatePostWithResourceBundleAtomicallyMock = vi.hoisted(() => vi.fn());
const createServiceClientMock = vi.hoisted(() => vi.fn());
const rateLimitRpcMock = vi.hoisted(() => vi.fn());
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

function expectPrivateNoStoreTraceHeaders(response: Response, requestId: string) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('x-request-id')).toBe(requestId);
}

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
const loadedGeneration = vi.hoisted(() => ({
  value: {
    id: 'generation-1',
    user_id: 'user-1',
    model: 'nano-banana-2',
    category: 'image',
    output_url: 'generated_images/user-1/example.jpg',
    showcase_asset_path: null as string | null,
  },
  updates: [] as Array<Record<string, unknown>>,
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

      if (table === 'generations') {
        const query = {
          select() {
            return query;
          },
          update(values: Record<string, unknown>) {
            loadedGeneration.updates.push(values);
            return query;
          },
          eq() {
            return query;
          },
          async maybeSingle() {
            return { data: loadedGeneration.value, error: null };
          },
          then(resolve: (value: { error: null }) => unknown) {
            return Promise.resolve({ error: null }).then(resolve);
          },
        };

        return query;
      }

      throw new Error(`Unexpected table access: ${table}`);
    },
    rpc(name: string, args: Record<string, unknown>) {
      if (name === 'check_backend_rate_limit') {
        return rateLimitRpcMock(name, args);
      }

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
    rateLimitRpcMock.mockReset();
    rateLimitRpcMock.mockResolvedValue({
      data: {
        allowed: true,
        limit: 60,
        remaining: 59,
        retryAfterSeconds: 0,
        resetAt: '2026-06-22T06:30:00.000Z',
      },
      error: null,
    });
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

  it('returns 429 before updating an owner post when mutation capacity is exhausted', async () => {
    rateLimitRpcMock.mockResolvedValue({
      data: {
        allowed: false,
        limit: 60,
        remaining: 0,
        retryAfterSeconds: 23,
        resetAt: '2026-06-22T06:30:00.000Z',
      },
      error: null,
    });

    const { PUT } = await import('@/app/api/posts/[postId]/route');
    const response = await PUT(new Request('http://localhost/api/posts/post-1', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token',
        'x-request-id': 'post-update-rate-limit',
      },
      body: JSON.stringify({
        title: 'Helpful launch proof',
        visibility: 'private',
        resourceBundle: { accessMode: 'none' },
      }),
    }) as NextRequest, {
      params: Promise.resolve({ postId: 'post-1' }),
    });
    const data = await response.json();

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('23');
    expectPrivateNoStoreTraceHeaders(response, 'post-update-rate-limit');
    expect(data).toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 23,
    });
    expect(rateLimitRpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'post:mutate',
      p_subject_key: 'user-1',
      p_limit: 60,
      p_window_seconds: 600,
    });
    expect(updatePostWithResourceBundleAtomicallyMock).not.toHaveBeenCalled();
    expect(sourceToolTableCalls.rpcCalls).toHaveLength(0);
  });

  it('returns 429 before deleting an owner post when mutation capacity is exhausted', async () => {
    rateLimitRpcMock.mockResolvedValue({
      data: {
        allowed: false,
        limit: 60,
        remaining: 0,
        retryAfterSeconds: 31,
        resetAt: '2026-06-22T06:30:00.000Z',
      },
      error: null,
    });

    const { DELETE } = await import('@/app/api/posts/[postId]/route');
    const response = await DELETE(new Request('http://localhost/api/posts/post-1', {
      method: 'DELETE',
      headers: {
        Authorization: 'Bearer token',
        'x-request-id': 'post-delete-rate-limit',
      },
    }) as NextRequest, {
      params: Promise.resolve({ postId: 'post-1' }),
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('31');
    expectPrivateNoStoreTraceHeaders(response, 'post-delete-rate-limit');
    expect(rateLimitRpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'post:mutate',
      p_subject_key: 'user-1',
      p_limit: 60,
      p_window_seconds: 600,
    });
  });

  it('updates private posts with draft unlock bundles without marketplace quality gating', async () => {
    const { PUT } = await import('@/app/api/posts/[postId]/route');
    const response = await PUT(new Request('http://localhost/api/posts/post-1', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token',
        'x-request-id': 'post-update-success',
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
    expectPrivateNoStoreTraceHeaders(response, 'post-update-success');
    expect(getMarketplaceQualityErrorForPostBundleMock).not.toHaveBeenCalled();
    expect(updatePostWithResourceBundleAtomicallyMock).toHaveBeenCalledWith(expect.objectContaining({
      patch: expect.objectContaining({
        visibility: 'private',
      }),
      hasBundlePayload: true,
    }));
    expect(data.visibility).toBe('private');
    expect(data.resourceBundleStatus).toBe('draft');
    expect(data.resourceBundlePath).toBe('/post/post-1/edit#recipe');
  });

  it('budgets for the post-response transcode the edit path defers', async () => {
    // Editing returns as soon as the post is saved and finishes any swapped-in
    // video rendition in an after() callback; without this it is cut short.
    const route = await import('@/app/api/posts/[postId]/route');

    expect(route.maxDuration).toBe(300);
    expect(route.runtime).toBe('nodejs');
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
    expect(data.resourceBundlePath).toBe('/showcase/post-1#recipe');
  });

  // A stored draft recipe no longer has to be resubmitted to make the post
  // public: the posts trigger promotes it if it passes the quality gate and
  // leaves it a draft otherwise. Refusing here is what left mobile users with
  // a free recipe unable to make their post public again at all.
  it('lets a post with a stored draft recipe go public and leaves promotion to the database', async () => {
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
      }),
    }) as NextRequest, {
      params: Promise.resolve({ postId: 'post-1' }),
    });

    const data = await response.json();

    expect(response.status, JSON.stringify(data)).toBe(200);
    // The post-level public gate still runs; the unsold draft itself is the
    // database's to judge, so no bundle is handed to the app-side check.
    expect(getMarketplaceQualityErrorForPostBundleMock).toHaveBeenCalledWith(expect.objectContaining({ bundle: null }));
    expect(updatePostWithResourceBundleAtomicallyMock).toHaveBeenCalledWith(expect.objectContaining({
      patch: expect.objectContaining({ visibility: 'public', title: 'Helpful launch proof' }),
      hasBundlePayload: false,
    }));
  });

  // The source of a post made from a creation is this product, and clients
  // send source fields for every post kind, so they are dropped rather than
  // refused.
  it('drops source tool fields for a generation-backed post and keeps the creation as its source', async () => {
    loadedPost.value = {
      ...loadedPost.value,
      generation_id: 'generation-1',
      category: 'image',
      post_format: 'media',
      showcase_asset_path: null,
      output_url: 'generated_images/user-1/example.jpg',
      source_tool: 'magicbooklet',
      source_tool_slug: 'magicbooklet',
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

    expect(response.status, JSON.stringify(data)).toBe(200);
    expect(updatePostWithResourceBundleAtomicallyMock).toHaveBeenCalledTimes(1);
    const patch = updatePostWithResourceBundleAtomicallyMock.mock.calls[0][0].patch as Record<string, unknown>;
    expect(patch).not.toHaveProperty('source_tool');
    expect(patch).not.toHaveProperty('source_tool_slug');
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
    expect(updatePostWithResourceBundleAtomicallyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        postId: 'post-1',
        ownerUserId: 'user-1',
        mediaItems: [
          expect.objectContaining({ storagePath: 'posts/post-1/second.jpg', sortOrder: 0 }),
          expect.objectContaining({ storagePath: 'posts/post-1/cover.jpg', sortOrder: 1 }),
        ],
      }),
    );
  });
});
