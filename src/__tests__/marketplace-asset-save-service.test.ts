import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { saveMarketplaceAssetForRoute } from '@/lib/marketplace-asset-save-service';

type PostRow = {
  id: string;
  user_id: string;
  visibility: 'public' | 'unlisted' | 'private';
  archived_at: string | null;
  review_status: string | null;
};

type MarketplaceAssetRow = {
  id: string;
  seller_user_id: string;
  post_id: string | null;
};

type WorkflowCanvasRow = {
  id: string;
  user_id: string;
  graph: Record<string, unknown>;
};

const POSTS: PostRow[] = [
  {
    id: 'post-public',
    user_id: 'user-1',
    visibility: 'public',
    archived_at: null,
    review_status: 'visible',
  },
  {
    id: 'post-private',
    user_id: 'user-1',
    visibility: 'private',
    archived_at: null,
    review_status: 'visible',
  },
];

function createAdminSupabaseMock(options?: {
  rateLimited?: boolean;
}) {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client = {
    async rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args });
      return {
        data: {
          allowed: !options?.rateLimited,
          limit: 60,
          remaining: options?.rateLimited ? 0 : 59,
          retryAfterSeconds: options?.rateLimited ? 31 : 0,
          resetAt: '2026-06-22T10:00:00.000Z',
        },
        error: null,
      };
    },
    from(table: string) {
      if (table !== 'posts') {
        throw new Error(`Unexpected admin table: ${table}`);
      }

      return {
        select() {
          const filters: Record<string, unknown> = {};
          return {
            eq(column: string, value: unknown) {
              filters[column] = value;
              return this;
            },
            async maybeSingle() {
              const row = POSTS.find((post) =>
                Object.entries(filters).every(([key, value]) => post[key as keyof PostRow] === value)
              ) ?? null;
              return { data: row, error: null };
            },
          };
        },
      };
    },
  };

  return {
    client: client as unknown as SupabaseClient,
    rpcCalls,
  };
}

function createUserSupabaseMock(options?: { sellerReady?: boolean }) {
  const marketplaceAssets: MarketplaceAssetRow[] = [];
  const workflowCanvases: WorkflowCanvasRow[] = [
    {
      id: 'canvas-1',
      user_id: 'user-1',
      graph: {
        nodes: [],
        edges: [],
      },
    },
  ];
  const assetUpserts: Array<Record<string, unknown>> = [];
  const contentUpserts: Array<Record<string, unknown>> = [];
  const sellerProfile = options?.sellerReady === false
    ? { username: 'creator-a1b2c3d4', display_name: 'New Creator', avatar_url: null }
    : { username: 'ready-creator', display_name: 'Ready Creator', avatar_url: 'https://cdn.example.com/avatar.jpg' };

  const client = {
    from(table: string) {
      if (table === 'profiles') {
        return {
          select() {
            return {
              eq() { return this; },
              async maybeSingle() {
                return { data: sellerProfile, error: null };
              },
            };
          },
        };
      }

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
                const row = POSTS.find((post) =>
                  Object.entries(filters).every(([key, value]) => post[key as keyof PostRow] === value)
                ) ?? null;
                return { data: row, error: null };
              },
            };
          },
        };
      }

      if (table === 'workflow_canvases') {
        return {
          select() {
            const filters: Record<string, unknown> = {};

            return {
              eq(column: string, value: unknown) {
                filters[column] = value;
                return this;
              },
              async maybeSingle() {
                const row = workflowCanvases.find((canvas) =>
                  Object.entries(filters).every(([key, value]) => canvas[key as keyof WorkflowCanvasRow] === value)
                ) ?? null;
                return { data: row, error: null };
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
                const row = marketplaceAssets.find((asset) =>
                  Object.entries(filters).every(([key, value]) => asset[key as keyof MarketplaceAssetRow] === value)
                ) ?? null;
                return { data: row, error: null };
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
            return { error: null };
          },
        };
      }

      throw new Error(`Unexpected table access: ${table}`);
    },
  };

  return {
    client: client as unknown as SupabaseClient,
    assetUpserts,
    contentUpserts,
  };
}

describe('saveMarketplaceAssetForRoute', () => {
  it('rate limits before parsing the request body or touching marketplace tables', async () => {
    const admin = createAdminSupabaseMock({ rateLimited: true });
    const userSupabase = createUserSupabaseMock();
    const readBody = vi.fn(async () => ({
      type: 'guide',
      status: 'active',
      title: 'Public proof guide',
      priceUsdCents: 1900,
      guideMarkdown: '# Guide',
    }));

    const result = await saveMarketplaceAssetForRoute({
      adminSupabase: admin.client,
      readBody,
      userId: 'user-1',
      userSupabase: userSupabase.client,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 429,
      body: {
        code: 'RATE_LIMITED',
        retryAfterSeconds: 31,
      },
    });
    expect(admin.rpcCalls[0]).toMatchObject({
      fn: 'check_backend_rate_limit',
      args: {
        p_scope: 'marketplace-asset:save',
        p_subject_key: 'user-1',
        p_limit: 60,
        p_window_seconds: 600,
      },
    });
    expect(readBody).not.toHaveBeenCalled();
    expect(userSupabase.assetUpserts).toHaveLength(0);
    expect(userSupabase.contentUpserts).toHaveLength(0);
  });

  it('validates ownership and saves linked marketplace content after rate limiting', async () => {
    const admin = createAdminSupabaseMock();
    const userSupabase = createUserSupabaseMock();

    const result = await saveMarketplaceAssetForRoute({
      adminSupabase: admin.client,
      readBody: async () => ({
        postId: 'post-public',
        type: 'guide',
        status: 'active',
        title: 'Public proof guide',
        description: 'Guide description',
        preview: 'Preview text',
        priceUsdCents: '1900',
        guideMarkdown: '# Guide',
      }),
      userId: 'user-1',
      userSupabase: userSupabase.client,
    });

    expect(result).toEqual({
      ok: true,
      body: {
        success: true,
        assetId: 'asset-new',
        postId: 'post-public',
        status: 'active',
      },
    });
    expect(userSupabase.assetUpserts).toHaveLength(1);
    expect(userSupabase.assetUpserts[0]).toMatchObject({
      seller_user_id: 'user-1',
      post_id: 'post-public',
      type: 'guide',
      status: 'active',
      price_usd_cents: 1900,
    });
    expect(userSupabase.contentUpserts).toEqual([
      {
        asset_id: 'asset-new',
        workflow_graph: null,
        prompt_pack: null,
        guide_markdown: '# Guide',
      },
    ]);
  });

  it('keeps active marketplace listings behind seller profile readiness', async () => {
    const admin = createAdminSupabaseMock();
    const userSupabase = createUserSupabaseMock({ sellerReady: false });

    const result = await saveMarketplaceAssetForRoute({
      adminSupabase: admin.client,
      readBody: async () => ({
        postId: 'post-public',
        type: 'guide',
        status: 'active',
        title: 'Public proof guide',
        priceUsdCents: 1900,
        guideMarkdown: '# Guide',
      }),
      userId: 'user-1',
      userSupabase: userSupabase.client,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      body: {
        field: 'profile',
        actionHref: '/profile',
      },
    });
    expect(userSupabase.assetUpserts).toHaveLength(0);
  });

  it('keeps directly accessible unlisted listings behind seller readiness too', async () => {
    const admin = createAdminSupabaseMock();
    const userSupabase = createUserSupabaseMock({ sellerReady: false });

    const result = await saveMarketplaceAssetForRoute({
      adminSupabase: admin.client,
      readBody: async () => ({
        type: 'prompt_pack',
        status: 'unlisted',
        title: 'Private launch hooks',
        priceUsdCents: 900,
        promptPack: 'Hook one\nHook two',
      }),
      userId: 'user-1',
      userSupabase: userSupabase.client,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      body: { field: 'profile' },
    });
    expect(userSupabase.assetUpserts).toHaveLength(0);
  });
});
