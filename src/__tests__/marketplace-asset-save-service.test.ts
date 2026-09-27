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
  assets?: MarketplaceAssetRow[];
}) {
  const tables = createUserSupabaseMock({ trusted: true, assets: options?.assets });
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
      if (table !== 'posts') return tables.client.from(table);

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
    assetUpserts: tables.assetUpserts,
    contentUpserts: tables.contentUpserts,
  };
}

function createUserSupabaseMock(options?: { sellerReady?: boolean; trusted?: boolean; assets?: MarketplaceAssetRow[] }) {
  const marketplaceAssets: MarketplaceAssetRow[] = options?.assets ?? [];
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
      if (table.startsWith('marketplace_') && !options?.trusted) {
        // Actual production grants: marketplace parents are service-only.
        const denied = { data: null, error: { code: '42501', message: 'permission denied' } };
        return {
          select() { return this; }, eq() { return this; }, upsert() { return this; },
          async maybeSingle() { return denied; }, async single() { return denied; },
        };
      }

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
  it('creates a draft with the service role while client marketplace grants are absent', async () => {
    const admin = createAdminSupabaseMock();
    const user = createUserSupabaseMock();
    const result = await saveMarketplaceAssetForRoute({
      adminSupabase: admin.client, userSupabase: user.client, userId: 'user-1',
      readBody: async () => ({ type: 'guide', status: 'draft', title: 'Draft',
        priceUsdCents: 0, guideMarkdown: '# Draft' }),
    });
    expect(result).toMatchObject({ ok: true, body: { assetId: 'asset-new' } });
    expect(admin.assetUpserts[0]).toMatchObject({ seller_user_id: 'user-1', status: 'draft' });
    expect(admin.contentUpserts).toHaveLength(1);
    expect(user.assetUpserts).toHaveLength(0);
    expect(user.contentUpserts).toHaveLength(0);
  });

  it.each(['user-2', null])('rejects edits to a foreign or missing listing (%s)', async (seller) => {
    const admin = createAdminSupabaseMock({ assets: seller
      ? [{ id: 'asset-existing', seller_user_id: seller, post_id: null }] : [] });
    const result = await saveMarketplaceAssetForRoute({
      adminSupabase: admin.client, userSupabase: createUserSupabaseMock().client, userId: 'user-1',
      readBody: async () => ({ assetId: 'asset-existing', type: 'guide', status: 'draft',
        title: 'Forged edit', priceUsdCents: 0, guideMarkdown: '# Forged' }),
    });
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(admin.assetUpserts).toHaveLength(0);
    expect(admin.contentUpserts).toHaveLength(0);
  });

  it('allows the verified owner to edit an existing listing', async () => {
    const admin = createAdminSupabaseMock({ assets:
      [{ id: 'asset-existing', seller_user_id: 'user-1', post_id: null }] });
    const result = await saveMarketplaceAssetForRoute({
      adminSupabase: admin.client, userSupabase: createUserSupabaseMock().client, userId: 'user-1',
      readBody: async () => ({ assetId: 'asset-existing', type: 'guide', status: 'draft',
        title: 'Updated', priceUsdCents: 0, guideMarkdown: '# Updated' }),
    });
    expect(result).toMatchObject({ ok: true, body: { assetId: 'asset-existing' } });
    expect(admin.assetUpserts[0]).toMatchObject({ id: 'asset-existing', seller_user_id: 'user-1' });
  });

  it('rejects an inaccessible linked post before privileged writes', async () => {
    const admin = createAdminSupabaseMock();
    const result = await saveMarketplaceAssetForRoute({
      adminSupabase: admin.client, userSupabase: createUserSupabaseMock().client, userId: 'user-2',
      readBody: async () => ({ postId: 'post-public', type: 'guide', status: 'draft',
        title: 'Foreign post', priceUsdCents: 0, guideMarkdown: '# Forged' }),
    });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(admin.assetUpserts).toHaveLength(0);
  });

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
    expect(admin.assetUpserts).toHaveLength(0);
    expect(admin.contentUpserts).toHaveLength(0);
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
    expect(admin.assetUpserts).toHaveLength(1);
    expect(admin.assetUpserts[0]).toMatchObject({
      seller_user_id: 'user-1',
      post_id: 'post-public',
      type: 'guide',
      status: 'active',
      price_usd_cents: 1900,
    });
    expect(admin.contentUpserts).toEqual([
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
    expect(admin.assetUpserts).toHaveLength(0);
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
    expect(admin.assetUpserts).toHaveLength(0);
  });
});
