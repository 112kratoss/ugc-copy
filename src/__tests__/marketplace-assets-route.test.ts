import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

type PostRow = {
  id: string;
  user_id: string;
  visibility: 'public' | 'unlisted' | 'private';
};

type MarketplaceAssetRow = {
  id: string;
  seller_user_id: string;
  post_id: string | null;
};

let postsState: PostRow[] = [];
let marketplaceAssetsState: MarketplaceAssetRow[] = [];
const assetUpserts: Array<Record<string, unknown>> = [];
const contentUpserts: Array<Record<string, unknown>> = [];
const createUserClientMock = vi.fn();

vi.mock('@/lib/server-helpers', () => ({
  createUserClient: (request: NextRequest) => createUserClientMock(request),
}));

describe('/api/marketplace/assets route', () => {
  beforeEach(() => {
    vi.resetModules();
    postsState = [
      {
        id: 'post-public',
        user_id: 'user-1',
        visibility: 'public',
      },
      {
        id: 'post-unlisted',
        user_id: 'user-1',
        visibility: 'unlisted',
      },
      {
        id: 'post-private',
        user_id: 'user-1',
        visibility: 'private',
      },
    ];
    marketplaceAssetsState = [];
    assetUpserts.length = 0;
    contentUpserts.length = 0;
    createUserClientMock.mockReset();
    createUserClientMock.mockReturnValue({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: 'user-1' } },
          error: null,
        })),
      },
      from(table: string) {
        if (table === 'posts') {
          return {
            select() {
              const filters: Record<string, unknown> = {};

              return {
                eq(column: string, value: unknown) {
                  filters[column] = value;
                  return this;
                },
                async maybeSingle() {
                  const row = postsState.find((post) =>
                    Object.entries(filters).every(([key, value]) => post[key as keyof PostRow] === value)
                  ) ?? null;
                  return {
                    data: row,
                    error: null,
                  };
                },
              };
            },
          };
        }

        if (table === 'marketplace_assets') {
          return {
            select() {
              const filters: Record<string, unknown> = {};

              return {
                eq(column: string, value: unknown) {
                  filters[column] = value;
                  return this;
                },
                async maybeSingle() {
                  const row = marketplaceAssetsState.find((asset) =>
                    Object.entries(filters).every(([key, value]) => asset[key as keyof MarketplaceAssetRow] === value)
                  ) ?? null;
                  return {
                    data: row,
                    error: null,
                  };
                },
              };
            },
            upsert(payload: Record<string, unknown>) {
              assetUpserts.push(payload);

              return {
                select() {
                  return {
                    async single() {
                      return {
                        data: {
                          id: (payload.id as string | undefined) ?? 'asset-new',
                          post_id: (payload.post_id as string | null | undefined) ?? null,
                          status: payload.status,
                        },
                        error: null,
                      };
                    },
                  };
                },
              };
            },
          };
        }

        if (table === 'marketplace_asset_content') {
          return {
            async upsert(payload: Record<string, unknown>) {
              contentUpserts.push(payload);
              return {
                error: null,
              };
            },
          };
        }

        throw new Error(`Unexpected table access: ${table}`);
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('allows active listings attached to public posts', async () => {
    const { POST } = await import('@/app/api/marketplace/assets/route');
    const response = await POST(new Request('http://localhost/api/marketplace/assets', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token',
      },
      body: JSON.stringify({
        postId: 'post-public',
        type: 'guide',
        status: 'active',
        title: 'Public proof guide',
        description: 'Guide description',
        preview: 'Preview text',
        priceUsdCents: 1900,
        guideMarkdown: '# Guide',
      }),
    }) as NextRequest);

    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(assetUpserts).toHaveLength(1);
    expect(assetUpserts[0]).toMatchObject({
      post_id: 'post-public',
      status: 'active',
    });
    expect(contentUpserts).toHaveLength(1);
  });

  it.each([
    ['post-unlisted', 'unlisted'],
    ['post-private', 'private'],
  ])('rejects active listings attached to %s posts', async (postId) => {
    const { POST } = await import('@/app/api/marketplace/assets/route');
    const response = await POST(new Request('http://localhost/api/marketplace/assets', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token',
      },
      body: JSON.stringify({
        postId,
        type: 'guide',
        status: 'active',
        title: 'Should fail',
        description: 'Guide description',
        preview: 'Preview text',
        priceUsdCents: 1900,
        guideMarkdown: '# Guide',
      }),
    }) as NextRequest);

    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toMatch(/active listings can only attach to public posts/i);
    expect(assetUpserts).toHaveLength(0);
    expect(contentUpserts).toHaveLength(0);
  });

  it('allows unlisted listings attached to non-public posts', async () => {
    const { POST } = await import('@/app/api/marketplace/assets/route');
    const response = await POST(new Request('http://localhost/api/marketplace/assets', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token',
      },
      body: JSON.stringify({
        postId: 'post-private',
        type: 'guide',
        status: 'unlisted',
        title: 'Private proof guide',
        description: 'Guide description',
        preview: 'Preview text',
        priceUsdCents: 1900,
        guideMarkdown: '# Guide',
      }),
    }) as NextRequest);

    expect(response.status).toBe(200);
    expect(assetUpserts).toHaveLength(1);
    expect(assetUpserts[0]).toMatchObject({
      post_id: 'post-private',
      status: 'unlisted',
    });
  });
});
