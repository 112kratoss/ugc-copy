import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const cacheMocks = vi.hoisted(() => ({
  invalidateShowcaseFeedCache: vi.fn(),
}));

vi.mock('@/lib/showcase-feed-cache', () => cacheMocks);

import {
  deleteOwnerPostForRoute,
  getCanonicalPostShowcaseAssetPath,
} from '@/lib/post-delete-service';

type QueryOperation = 'select' | 'insert' | 'update' | 'delete';

type MockPost = {
  id: string;
  user_id: string;
  generation_id: string | null;
  visibility: 'public' | 'unlisted' | 'private';
  title: string | null;
  source_kind: string;
  showcase_asset_path: string | null;
};

type MockBundle = {
  id: string;
  access_mode: 'free' | 'paid';
  status: 'draft' | 'published';
  price_usd_cents: number;
  sales_count: number;
  earnings_usd_cents: number;
  prompt_text: string | null;
  notes_markdown: string | null;
  workflow_share_url: string | null;
  workflow_snapshot: unknown;
  attachments: unknown;
  resource_sections?: unknown;
  resource_items?: unknown;
  allow_remix: boolean;
};

function createSupabaseMock({
  post,
  bundle,
  generation,
  bundleError = null,
  purchases = [],
  pendingOrders = [],
}: {
  post: MockPost | null;
  bundle: MockBundle | null;
  generation?: { id: string; user_id?: string; showcase_asset_path: string | null } | null;
  bundleError?: { message: string } | null;
  purchases?: Array<{ bundle_id: string }>;
  pendingOrders?: Array<{ id: string }>;
}) {
  const calls = {
    rpc: [] as Array<{ name: string; args: Record<string, unknown> }>,
    audits: [] as Array<Record<string, unknown>>,
    updates: [] as Array<{ table: string; patch: Record<string, unknown>; filters: Record<string, unknown> }>,
    deletes: [] as Array<{ table: string; filters: Record<string, unknown> }>,
    removals: [] as Array<{ bucket: string; paths: string[] }>,
  };

  function createQuery(table: string) {
    let operation: QueryOperation = 'select';
    let patch: Record<string, unknown> = {};
    const filters: Record<string, unknown> = {};

    const resolve = async () => {
      if (operation === 'update') {
        calls.updates.push({ table, patch, filters });
      }

      if (operation === 'delete') {
        calls.deletes.push({ table, filters });
      }

      return { data: null, error: null };
    };

    const query = {
      select() {
        operation = 'select';
        return query;
      },
      eq(column: string, value: unknown) {
        filters[column] = value;
        return query;
      },
      gt(column: string, value: unknown) {
        filters[`${column}:gt`] = value;
        return query;
      },
      limit() {
        if (table === 'post_resource_bundle_purchases') {
          return Promise.resolve({ data: purchases, error: null });
        }
        if (table === 'post_resource_bundle_orders') {
          return Promise.resolve({ data: pendingOrders, error: null });
        }

        return Promise.resolve({ data: [], error: null });
      },
      maybeSingle() {
        if (table === 'posts') {
          return Promise.resolve({ data: post, error: null });
        }

        if (table === 'post_resource_bundles') {
          return Promise.resolve({ data: bundle, error: bundleError });
        }

        if (table === 'generations') {
          const matchesOwner = !filters.user_id
            || !generation?.user_id
            || generation.user_id === filters.user_id;
          return Promise.resolve({ data: matchesOwner ? generation ?? null : null, error: null });
        }

        return Promise.resolve({ data: null, error: null });
      },
      insert(value: Record<string, unknown>) {
        operation = 'insert';
        if (table === 'post_deletion_audits') {
          calls.audits.push(value);
        }
        return Promise.resolve({ data: null, error: null });
      },
      update(value: Record<string, unknown>) {
        operation = 'update';
        patch = value;
        return query;
      },
      delete() {
        operation = 'delete';
        return query;
      },
      then(resolveThen: (value: { data: null; error: null }) => unknown, rejectThen?: (reason: unknown) => unknown) {
        return resolve().then(resolveThen, rejectThen);
      },
    };

    return query;
  }

  const client = {
    from: vi.fn(createQuery),
    rpc: vi.fn((name: string, args: Record<string, unknown>) => {
      calls.rpc.push({ name, args });
      return Promise.resolve({
        data: {
          allowed: true,
          limit: 60,
          remaining: 59,
          retryAfterSeconds: 0,
          resetAt: '2026-06-22T06:30:00.000Z',
        },
        error: null,
      });
    }),
    storage: {
      from: vi.fn((bucket: string) => ({
        remove: vi.fn((paths: string[]) => {
          calls.removals.push({ bucket, paths });
          return Promise.resolve({ data: null, error: null });
        }),
      })),
    },
  };

  return { client: client as unknown as SupabaseClient, calls };
}

describe('deleteOwnerPostForRoute', () => {
  beforeEach(() => {
    cacheMocks.invalidateShowcaseFeedCache.mockClear();
  });

  it('canonicalizes only the selected post or linked-generation showcase path', () => {
    expect(getCanonicalPostShowcaseAssetPath(
      'posts/post-1/cover.webp',
      'post-1',
      'generation-1',
    )).toBe('posts/post-1/cover.webp');
    expect(getCanonicalPostShowcaseAssetPath(
      'showcase/generation-1/output.webp',
      'post-1',
      'generation-1',
    )).toBe('showcase/generation-1/output.webp');

    for (const storagePath of [
      'posts/post-2/private.webp',
      'showcase/generation-2/private.webp',
      'posts/post-1/../post-2/private.webp',
      'posts/post-1/%252fpost-2/private.webp',
      'posts/post-1/%255cpost-2/private.webp',
    ]) {
      expect(getCanonicalPostShowcaseAssetPath(
        storagePath,
        'post-1',
        'generation-1',
      )).toBeNull();
    }
  });

  it('blocks posts with unlocks unless force delete is explicitly requested', async () => {
    const { client, calls } = createSupabaseMock({
      purchases: [{ bundle_id: 'bundle-1' }],
      post: {
        id: 'post-1',
        user_id: 'user-1',
        generation_id: null,
        visibility: 'public',
        title: 'Launch prompt',
        source_kind: 'manual',
        showcase_asset_path: 'posts/post-1/cover.jpg',
      },
      bundle: {
        id: 'bundle-1',
        access_mode: 'paid',
        status: 'published',
        price_usd_cents: 500,
        sales_count: 2,
        earnings_usd_cents: 1000,
        prompt_text: 'Reusable launch prompt',
        notes_markdown: null,
        workflow_share_url: null,
        workflow_snapshot: null,
        attachments: [],
        allow_remix: false,
      },
    });

    const result = await deleteOwnerPostForRoute({
      adminSupabase: client,
      ownerUserId: 'user-1',
      postId: 'post-1',
      forceDelete: false,
    });

    expect(result).toEqual({
      ok: false,
      status: 409,
      body: {
        error: 'People have already unlocked this post. Deleting it removes it from your profile and every public surface, but buyers keep the version they unlocked. Archiving does the same and is reversible.',
        requiresForceDelete: true,
      },
    });
    expect(calls.rpc).toEqual([
      {
        name: 'check_backend_rate_limit',
        args: {
          p_scope: 'post:mutate',
          p_subject_key: 'user-1',
          p_limit: 60,
          p_window_seconds: 600,
        },
      },
    ]);
    expect(calls.audits).toHaveLength(0);
    expect(calls.deletes).toHaveLength(0);
    expect(calls.removals).toHaveLength(0);
    expect(cacheMocks.invalidateShowcaseFeedCache).not.toHaveBeenCalled();
  });

  it('tombstones a sold post instead of destroying buyer entitlements', async () => {
    const { client, calls } = createSupabaseMock({
      purchases: [{ bundle_id: 'bundle-1' }],
      post: {
        id: 'post-1',
        user_id: 'user-1',
        generation_id: 'generation-1',
        visibility: 'public',
        title: ' Launch prompt ',
        source_kind: 'generation',
        showcase_asset_path: 'posts/post-1/cover.jpg',
      },
      bundle: {
        id: 'bundle-1',
        access_mode: 'paid',
        status: 'published',
        price_usd_cents: 500,
        sales_count: 2,
        earnings_usd_cents: 1000,
        prompt_text: 'Reusable launch prompt',
        notes_markdown: 'Buyer notes',
        workflow_share_url: null,
        workflow_snapshot: null,
        attachments: [],
        allow_remix: false,
      },
      generation: {
        id: 'generation-1',
        showcase_asset_path: 'posts/post-1/cover.jpg',
      },
    });

    const result = await deleteOwnerPostForRoute({
      adminSupabase: client,
      ownerUserId: 'user-1',
      postId: 'post-1',
      forceDelete: true,
    });

    expect(result).toEqual({
      ok: true,
      body: {
        success: true,
        deleted: true,
        tombstoned: true,
      },
    });
    expect(calls.audits).toEqual([
      expect.objectContaining({
        post_id: 'post-1',
        owner_user_id: 'user-1',
        generation_id: 'generation-1',
        title: 'Launch prompt',
        bundle_access_mode: 'paid',
        bundle_status: 'published',
        bundle_price_usd_cents: 500,
        bundle_resource_kinds: ['prompt', 'notes'],
        sales_count: 2,
        earnings_usd_cents: 1000,
        had_paid_orders: true,
      }),
    ]);

    // The post row survives, private and archived, so the buyer's library keeps
    // the title and cover that give their purchase context.
    const tombstone = calls.updates.find((update) => update.table === 'posts');
    expect(tombstone?.patch).toMatchObject({
      visibility: 'private',
      archived_by_user_id: 'user-1',
    });
    expect(tombstone?.patch.tombstoned_at).toEqual(expect.any(String));
    expect(tombstone?.patch.archived_at).toEqual(expect.any(String));

    // The unlock is delisted so it can never be sold again.
    const retirement = calls.updates.find((update) => update.table === 'post_resource_bundles');
    expect(retirement?.patch).toMatchObject({ status: 'draft' });
    expect(retirement?.filters).toEqual({ id: 'bundle-1' });

    // Nothing is destroyed: no delete, and the media buyers paid for stays.
    expect(calls.deletes).toHaveLength(0);
    expect(calls.removals).toHaveLength(0);
    expect(cacheMocks.invalidateShowcaseFeedCache).toHaveBeenCalledTimes(1);
  });

  it('tombstones a post with a still-payable cash order so its frozen quote can settle', async () => {
    const { client, calls } = createSupabaseMock({
      purchases: [],
      pendingOrders: [{ id: 'order-pending-1' }],
      post: {
        id: 'post-1',
        user_id: 'user-1',
        generation_id: null,
        visibility: 'public',
        title: 'Launch prompt',
        source_kind: 'manual',
        showcase_asset_path: 'posts/post-1/cover.jpg',
      },
      bundle: {
        id: 'bundle-1',
        access_mode: 'paid',
        status: 'published',
        price_usd_cents: 500,
        sales_count: 0,
        earnings_usd_cents: 0,
        prompt_text: 'Reusable launch prompt',
        notes_markdown: null,
        workflow_share_url: null,
        workflow_snapshot: null,
        attachments: [],
        allow_remix: false,
      },
    });

    const result = await deleteOwnerPostForRoute({
      adminSupabase: client,
      ownerUserId: 'user-1',
      postId: 'post-1',
      forceDelete: true,
    });

    expect(result).toEqual({
      ok: true,
      body: { success: true, deleted: true, tombstoned: true },
    });
    expect(calls.updates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: 'posts',
        patch: expect.objectContaining({ visibility: 'private' }),
      }),
      expect.objectContaining({
        table: 'post_resource_bundles',
        patch: expect.objectContaining({ status: 'draft' }),
      }),
    ]));
    expect(calls.deletes).toEqual([]);
    expect(calls.removals).toEqual([]);
  });

  it('hard deletes a post whose unlock was never bought', async () => {
    const { client, calls } = createSupabaseMock({
      purchases: [],
      post: {
        id: 'post-1',
        user_id: 'user-1',
        generation_id: 'generation-1',
        visibility: 'public',
        title: ' Launch prompt ',
        source_kind: 'generation',
        showcase_asset_path: 'posts/post-1/cover.jpg',
      },
      bundle: {
        id: 'bundle-1',
        access_mode: 'paid',
        status: 'published',
        price_usd_cents: 500,
        sales_count: 0,
        earnings_usd_cents: 0,
        prompt_text: 'Reusable launch prompt',
        notes_markdown: null,
        workflow_share_url: null,
        workflow_snapshot: null,
        attachments: [],
        allow_remix: false,
      },
      generation: {
        id: 'generation-1',
        showcase_asset_path: 'posts/post-1/cover.jpg',
      },
    });

    const result = await deleteOwnerPostForRoute({
      adminSupabase: client,
      ownerUserId: 'user-1',
      postId: 'post-1',
      forceDelete: false,
    });

    expect(result).toEqual({
      ok: true,
      body: {
        success: true,
        deleted: true,
      },
    });
    expect(calls.deletes).toEqual([
      {
        table: 'posts',
        filters: {
          id: 'post-1',
          user_id: 'user-1',
        },
      },
    ]);
    expect(calls.removals).toEqual([
      {
        bucket: 'showcase_media',
        paths: ['posts/post-1/cover.jpg'],
      },
    ]);
  });

  it('does not remove a foreign generation showcase path referenced by an owned post', async () => {
    const foreignGenerationId = 'generation-2';
    const { client, calls } = createSupabaseMock({
      purchases: [],
      post: {
        id: 'post-1',
        user_id: 'user-1',
        generation_id: foreignGenerationId,
        visibility: 'public',
        title: 'Tampered link',
        source_kind: 'generation',
        showcase_asset_path: `showcase/${foreignGenerationId}/private.jpg`,
      },
      bundle: null,
      generation: {
        id: foreignGenerationId,
        user_id: 'user-2',
        showcase_asset_path: `showcase/${foreignGenerationId}/private.jpg`,
      },
    });

    await expect(deleteOwnerPostForRoute({
      adminSupabase: client,
      ownerUserId: 'user-1',
      postId: 'post-1',
    })).resolves.toMatchObject({ ok: true });

    expect(calls.removals).toEqual([]);
    expect(calls.updates.some((update) => update.table === 'generations')).toBe(false);
  });

  it('does not delete the post when bundle state cannot be loaded for the audit decision', async () => {
    const { client, calls } = createSupabaseMock({
      post: {
        id: 'post-1',
        user_id: 'user-1',
        generation_id: null,
        visibility: 'public',
        title: 'Launch prompt',
        source_kind: 'manual',
        showcase_asset_path: 'posts/post-1/cover.jpg',
      },
      bundle: null,
      bundleError: { message: 'database unavailable' },
    });

    const result = await deleteOwnerPostForRoute({
      adminSupabase: client,
      ownerUserId: 'user-1',
      postId: 'post-1',
      forceDelete: true,
    });

    expect(result).toEqual({
      ok: false,
      status: 500,
      body: {
        error: 'Failed to delete post.',
      },
    });
    expect(calls.audits).toHaveLength(0);
    expect(calls.deletes).toHaveLength(0);
    expect(calls.removals).toHaveLength(0);
  });
});
