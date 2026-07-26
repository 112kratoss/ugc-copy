import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const getMarketplaceQualityErrorForPostBundleMock = vi.hoisted(() => vi.fn());
const savePostResourceBundleMock = vi.hoisted(() => vi.fn());
const rateLimitRpcMock = vi.hoisted(() => vi.fn());
const loadedPost = vi.hoisted(() => ({
  value: {
    id: 'post-1',
    user_id: 'user-1',
    title: 'Draft post',
    body: 'A private proof post with a draft unlock.',
    visibility: 'private',
    archived_at: null,
    review_status: 'visible',
    showcase_asset_path: null,
    output_url: null,
  },
}));

vi.mock('@/lib/post-resource-bundles-server', () => ({
  getMarketplaceQualityErrorForPostBundle: getMarketplaceQualityErrorForPostBundleMock,
  getPostResourceBundleDetailByPostId: vi.fn(),
  savePostResourceBundle: savePostResourceBundleMock,
}));

vi.mock('@/lib/server-helpers', () => ({
  createUserClient: () => ({
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: 'user-1' } },
        error: null,
      })),
    },
    from(table: string) {
      if (table !== 'posts') {
        throw new Error(`Unexpected table access: ${table}`);
      }

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
    },
  }),
  createServiceClient: () => ({
    rpc: rateLimitRpcMock,
    from(table: string) {
      if (table !== 'posts') {
        throw new Error(`Unexpected service table access: ${table}`);
      }
      const query = {
        select() { return query; },
        eq() { return query; },
        async maybeSingle() {
          return { data: loadedPost.value, error: null };
        },
      };
      return query;
    },
  }),
}));

function expectPrivateNoStoreTraceHeaders(response: Response, requestId: string) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('x-request-id')).toBe(requestId);
}

describe('/api/posts/[postId]/resource-bundle route', () => {
  beforeEach(() => {
    vi.resetModules();
    loadedPost.value = {
      id: 'post-1',
      user_id: 'user-1',
      title: 'Draft post',
      body: 'A private proof post with a draft unlock.',
      visibility: 'private',
      archived_at: null,
      review_status: 'visible',
      showcase_asset_path: null,
      output_url: null,
    };
    getMarketplaceQualityErrorForPostBundleMock.mockReset();
    getMarketplaceQualityErrorForPostBundleMock.mockResolvedValue('Quality should not run for private draft unlocks.');
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
    savePostResourceBundleMock.mockReset();
    savePostResourceBundleMock.mockResolvedValue({
      id: 'bundle-1',
      status: 'draft',
    });
  });

  it('saves private draft unlock bundles without marketplace quality gating', async () => {
    const { PUT } = await import('@/app/api/posts/[postId]/resource-bundle/route');
    const response = await PUT(new Request('http://localhost/api/posts/post-1/resource-bundle', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token',
        'x-request-id': 'resource-bundle-save-1',
      },
      body: JSON.stringify({
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
    expectPrivateNoStoreTraceHeaders(response, 'resource-bundle-save-1');
    expect(getMarketplaceQualityErrorForPostBundleMock).not.toHaveBeenCalled();
    expect(savePostResourceBundleMock).toHaveBeenCalledWith(expect.objectContaining({
      postVisibility: 'private',
    }));
    expect(data.success).toBe(true);
  });
});
