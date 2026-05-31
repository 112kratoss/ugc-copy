import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const getMarketplaceQualityErrorForPostBundleMock = vi.hoisted(() => vi.fn());
const updatePostWithResourceBundleAtomicallyMock = vi.hoisted(() => vi.fn());
const loadedPost = vi.hoisted(() => ({
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
  createServiceClient: () => ({
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

      throw new Error(`Unexpected table access: ${table}`);
    },
  }),
}));

vi.mock('@/lib/post-resource-bundles-server', () => ({
  getMarketplaceQualityErrorForPostBundle: getMarketplaceQualityErrorForPostBundleMock,
  updatePostWithResourceBundleAtomically: updatePostWithResourceBundleAtomicallyMock,
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
    updatePostWithResourceBundleAtomicallyMock.mockReset();
    updatePostWithResourceBundleAtomicallyMock.mockImplementation(async ({ patch }) => ({
      postId: 'post-1',
      visibility: patch.visibility,
      bundleId: 'bundle-1',
      bundleStatus: patch.visibility === 'public' ? 'published' : 'draft',
    }));
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
});
