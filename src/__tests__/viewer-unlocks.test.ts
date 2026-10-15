import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const { loadMediaItems } = vi.hoisted(() => ({ loadMediaItems: vi.fn() }));

vi.mock('@/lib/posts-server', () => ({
  getPostMediaKind: (category: string) => (category === 'video' ? 'video' : 'image'),
  resolvePostMediaUrl: async (_client: unknown, row: { showcase_asset_path: string | null }) => (
    row.showcase_asset_path ? `https://media.example.com/${row.showcase_asset_path}` : null
  ),
}));

vi.mock('@/lib/post-media', () => ({
  loadPostMediaItemsMap: loadMediaItems,
}));

import { listViewerUnlocks, normalizeViewerUnlocksPageParams } from '@/lib/viewer-unlocks';

function createRow(overrides: Record<string, unknown> = {}) {
  return {
    purchase_id: '11111111-1111-4111-8111-111111111111',
    bundle_id: 'bundle-1',
    post_id: 'post-1',
    bundle_title: 'Launch hook recipe',
    preview_text: 'The prompt behind the hook.',
    access_mode: 'paid',
    price_usd_cents: 500,
    purchased_at: '2026-07-01T00:00:00.000Z',
    purchase_price_usd_cents: 500,
    purchased_revision_number: 1,
    has_newer_revision: false,
    bundle_retired: false,
    post_title: 'Launch post',
    post_body: null,
    post_category: 'image',
    post_format: 'media',
    post_showcase_asset_path: 'posts/post-1/cover.jpg',
    post_output_url: null,
    post_tombstoned: false,
    post_visibility: 'public',
    owner_user_id: 'owner-1',
    owner_username: 'creator',
    owner_display_name: 'Creator',
    owner_avatar_url: null,
    total_count: 1,
    ...overrides,
  };
}

type QueryFilters = {
  select: string;
  in: Record<string, unknown[]>;
  is: Record<string, unknown>;
};

type TableReader = (filters: QueryFilters) => { data: unknown; error: unknown };

/**
 * The projection plus the batched table reads a page makes. Every read
 * resolves through the table's reader, with the filters it was asked for.
 */
function createSupabaseMock(
  rows: Array<Record<string, unknown>>,
  tables: Partial<Record<string, TableReader>> = {},
) {
  const rpc = vi.fn(async () => ({ data: rows, error: null }));
  const reads: Array<{ table: string; filters: QueryFilters }> = [];
  const from = vi.fn((table: string) => {
    const filters: QueryFilters = { select: '', in: {}, is: {} };
    reads.push({ table, filters });
    const query = {
      select: (columns: string) => {
        filters.select = columns;
        return query;
      },
      in: (column: string, values: unknown[]) => {
        filters.in[column] = values;
        return query;
      },
      is: (column: string, value: unknown) => {
        filters.is[column] = value;
        return query;
      },
      order: () => query,
      then: (
        onFulfilled: (value: { data: unknown; error: unknown }) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => Promise.resolve(tables[table]?.(filters) ?? { data: [], error: null }).then(onFulfilled, onRejected),
    };
    return query;
  });
  const storage = {
    from: () => ({ getPublicUrl: (path: string) => ({ data: { publicUrl: `https://cdn.example.test/${path}` } }) }),
  };
  return { client: { rpc, from, storage } as unknown as SupabaseClient, rpc, from, reads };
}

/** `posts` answers both the NSFW read and the unarchived check for live previews. */
function postsTable({ nsfw = [] as string[], archived = [] as string[] } = {}): TableReader {
  return (filters) => {
    const ids = (filters.in.id ?? []) as string[];
    if ('archived_at' in filters.is) {
      return { data: ids.filter((id) => !archived.includes(id)).map((id) => ({ id })), error: null };
    }
    return { data: ids.map((id) => ({ id, is_nsfw: nsfw.includes(id) })), error: null };
  };
}

function snapshotRow(overrides: Record<string, unknown> = {}) {
  return {
    purchase_id: '11111111-1111-4111-8111-111111111111',
    storage_path: 'private-posts/22222222-2222-4222-8222-222222222222/clip.mp4',
    external_url: null,
    preview_storage_path: 'private-posts/22222222-2222-4222-8222-222222222222/clip-poster.webp',
    preview_thumbhash: 'snapshot-thumb',
    media_kind: 'video',
    sort_order: 0,
    ...overrides,
  };
}

function liveMediaItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'media-1',
    url: 'https://cdn.example.test/posts/post-1/original.png',
    previewUrl: 'https://cdn.example.test/posts/post-1/preview.webp',
    previewThumbhash: 'live-thumb',
    previewStatus: 'ready',
    mediaKind: 'image',
    sortOrder: 0,
    ...overrides,
  };
}

const proxyUrl = (path: string) => `/api/media?${new URLSearchParams({ bucket: 'post_media', path })}`;

describe('listViewerUnlocks', () => {
  beforeEach(() => {
    loadMediaItems.mockReset();
    loadMediaItems.mockResolvedValue(new Map());
  });

  it('asks the projection for the caller\'s own library only', async () => {
    const { client, rpc } = createSupabaseMock([createRow()]);

    await listViewerUnlocks({ adminSupabase: client, viewerUserId: 'buyer-1' });

    expect(rpc).toHaveBeenCalledWith('list_viewer_post_resource_unlocks', {
      p_buyer_user_id: 'buyer-1',
      p_limit: 24,
      p_offset: 0,
    });
  });

  it('maps an unlock into the shape the library renders', async () => {
    const { client } = createSupabaseMock([createRow()]);

    const page = await listViewerUnlocks({ adminSupabase: client, viewerUserId: 'buyer-1' });

    expect(page.items[0]).toMatchObject({
      unlockId: '11111111-1111-4111-8111-111111111111',
      bundleId: 'bundle-1',
      postId: 'post-1',
      title: 'Launch hook recipe',
      purchasePriceUsdCents: 500,
      retired: false,
      tombstoned: false,
      creator: { displayName: 'Creator', username: 'creator' },
    });
    expect(page.items[0].post?.mediaUrl).toBe('https://media.example.com/posts/post-1/cover.jpg');
  });

  it('keeps detached purchases addressable by purchase UUID', async () => {
    const { client } = createSupabaseMock([createRow({
      bundle_id: null,
      post_id: null,
      post_tombstoned: true,
      bundle_retired: true,
    })]);

    const page = await listViewerUnlocks({ adminSupabase: client, viewerUserId: 'buyer-1' });

    expect(page.items[0]).toMatchObject({
      unlockId: '11111111-1111-4111-8111-111111111111',
      bundleId: null,
      postId: null,
    });
  });

  it('keeps a tombstoned unlock and flags it', async () => {
    // The creator deleted the post; the buyer still paid for this.
    const { client } = createSupabaseMock([createRow({
      post_tombstoned: true,
      bundle_retired: true,
      post_visibility: 'private',
    })]);

    const page = await listViewerUnlocks({ adminSupabase: client, viewerUserId: 'buyer-1' });

    expect(page.items).toHaveLength(1);
    expect(page.items[0].tombstoned).toBe(true);
    expect(page.items[0].retired).toBe(true);
  });

  it('flags an unlock the creator has since improved', async () => {
    const { client } = createSupabaseMock([createRow({ has_newer_revision: true })]);

    const page = await listViewerUnlocks({ adminSupabase: client, viewerUserId: 'buyer-1' });

    expect(page.items[0].hasNewerRevision).toBe(true);
  });

  it('derives a title from the body for text posts with no title', async () => {
    const { client } = createSupabaseMock([createRow({
      post_title: null,
      post_body: 'A short note about the hook',
      post_format: 'text',
    })]);

    const page = await listViewerUnlocks({ adminSupabase: client, viewerUserId: 'buyer-1' });

    expect(page.items[0].post?.title).toBe('A short note about the hook');
  });

  it('reports pagination from the window total, not the page length', async () => {
    const { client } = createSupabaseMock([createRow({ total_count: 30 })]);

    const page = await listViewerUnlocks({ adminSupabase: client, viewerUserId: 'buyer-1' });

    expect(page.pageInfo).toMatchObject({ total: 30, hasMore: true, nextOffset: 1 });
  });

  it('returns an empty page rather than failing when nothing was unlocked', async () => {
    const { client } = createSupabaseMock([]);

    const page = await listViewerUnlocks({ adminSupabase: client, viewerUserId: 'buyer-1' });

    expect(page.items).toEqual([]);
    expect(page.pageInfo).toMatchObject({ total: 0, hasMore: false, nextOffset: null });
  });

  it('clamps page parameters so a caller cannot request an unbounded page', () => {
    expect(normalizeViewerUnlocksPageParams({ limit: 500, offset: -10 })).toEqual({
      limit: 48,
      offset: 0,
    });
    expect(normalizeViewerUnlocksPageParams({})).toEqual({ limit: 24, offset: 0 });
  });

  describe('thumbnails', () => {
    it('covers a video unlock with the poster from its purchase snapshot', async () => {
      const { client } = createSupabaseMock([createRow({ post_category: 'video' })], {
        posts: postsTable(),
        // Ordered by sort_order, as the read asks; the first item is the cover.
        post_resource_purchase_media: () => ({
          data: [
            snapshotRow(),
            snapshotRow({ preview_storage_path: 'private-posts/22222222-2222-4222-8222-222222222222/second.webp', sort_order: 1 }),
          ],
          error: null,
        }),
      });

      const page = await listViewerUnlocks({ adminSupabase: client, viewerUserId: 'buyer-1' });

      expect(page.items[0].post).toMatchObject({
        mediaKind: 'video',
        previewUrl: proxyUrl('private-posts/22222222-2222-4222-8222-222222222222/clip-poster.webp'),
        previewThumbhash: 'snapshot-thumb',
      });
      // Store builds still read the original.
      expect(page.items[0].post?.mediaUrl).toBe('https://media.example.com/posts/post-1/cover.jpg');
      // A snapshot answers on its own; the live post is not asked.
      expect(loadMediaItems).not.toHaveBeenCalled();
    });

    it('draws a snapshot image without a preview from the image itself, and a video without a poster as nothing', async () => {
      const second = '22222222-2222-4222-8222-222222222223';
      const { client } = createSupabaseMock([
        createRow(),
        createRow({ purchase_id: second, post_id: 'post-2', post_category: 'video' }),
      ], {
        posts: postsTable(),
        post_resource_purchase_media: () => ({
          data: [
            snapshotRow({ storage_path: 'posts/33333333-3333-4333-8333-333333333333/still.png', preview_storage_path: null, preview_thumbhash: null, media_kind: 'image' }),
            snapshotRow({ purchase_id: second, preview_storage_path: null, preview_thumbhash: null }),
          ],
          error: null,
        }),
      });

      const page = await listViewerUnlocks({ adminSupabase: client, viewerUserId: 'buyer-1' });

      expect(page.items[0].post?.previewUrl).toBe(proxyUrl('posts/33333333-3333-4333-8333-333333333333/still.png'));
      expect(page.items[1].post?.previewUrl).toBeNull();
      expect(loadMediaItems).not.toHaveBeenCalled();
    });

    it('borrows a public post\'s live preview for an image unlock bought before snapshots', async () => {
      loadMediaItems.mockResolvedValue(new Map([['post-1', [liveMediaItem()]]]));
      const { client } = createSupabaseMock([createRow()], { posts: postsTable() });

      const page = await listViewerUnlocks({ adminSupabase: client, viewerUserId: 'buyer-1' });

      expect(page.items[0].post).toMatchObject({
        previewUrl: 'https://cdn.example.test/posts/post-1/preview.webp',
        previewThumbhash: 'live-thumb',
      });
      expect(loadMediaItems).toHaveBeenCalledWith(client, ['post-1']);
    });

    it('keeps a private, archived or deleted post to its snapshot, so one bought before snapshots has no thumbnail', async () => {
      loadMediaItems.mockImplementation(async (_client: unknown, postIds: string[]) => (
        new Map(postIds.map((postId) => [postId, [liveMediaItem()]]))
      ));
      const { client } = createSupabaseMock([
        createRow({ purchase_id: 'purchase-private', post_id: 'post-private', post_visibility: 'private' }),
        createRow({ purchase_id: 'purchase-archived', post_id: 'post-archived' }),
        createRow({ purchase_id: 'purchase-deleted', post_id: 'post-deleted', post_tombstoned: true }),
        createRow({ purchase_id: 'purchase-unlisted', post_id: 'post-unlisted', post_visibility: 'unlisted' }),
      ], { posts: postsTable({ archived: ['post-archived'] }) });

      const page = await listViewerUnlocks({ adminSupabase: client, viewerUserId: 'buyer-1' });

      expect(page.items.map((item) => item.post?.previewUrl)).toEqual([
        null,
        null,
        null,
        'https://cdn.example.test/posts/post-1/preview.webp',
      ]);
      expect(loadMediaItems).toHaveBeenCalledWith(client, ['post-archived', 'post-unlisted']);
    });

    it('has no thumbnail for a live video whose poster is not ready yet', async () => {
      loadMediaItems.mockResolvedValue(new Map([['post-1', [liveMediaItem({
        mediaKind: 'video',
        previewUrl: 'https://cdn.example.test/posts/post-1/half-written.webp',
        previewStatus: 'processing',
      })]]]));
      const { client } = createSupabaseMock([createRow({ post_category: 'video' })], { posts: postsTable() });

      const page = await listViewerUnlocks({ adminSupabase: client, viewerUserId: 'buyer-1' });

      expect(page.items[0].post?.previewUrl).toBeNull();
    });

    it('flags an NSFW row and keeps its cover for the client to cover until a tap', async () => {
      loadMediaItems.mockResolvedValue(new Map([['post-1', [liveMediaItem()]]]));
      const { client } = createSupabaseMock([createRow()], {
        posts: postsTable({ nsfw: ['post-1'] }),
        post_resource_purchase_media: () => ({ data: [snapshotRow()], error: null }),
      });

      const page = await listViewerUnlocks({ adminSupabase: client, viewerUserId: 'buyer-1' });

      // The buyer may read it (the purchase is the entitlement, 20261014092058);
      // the flag is what tells the client to draw the plate over it.
      expect(page.items[0].isNsfw).toBe(true);
      expect(page.items[0].post).toMatchObject({
        previewUrl: proxyUrl('private-posts/22222222-2222-4222-8222-222222222222/clip-poster.webp'),
        previewThumbhash: 'snapshot-thumb',
      });
      expect(loadMediaItems).not.toHaveBeenCalled();
    });

    it('fails the page rather than drop a content warning it could not read', async () => {
      const { client } = createSupabaseMock([createRow()], {
        posts: () => ({ data: null, error: new Error('posts unavailable') }),
      });

      await expect(listViewerUnlocks({ adminSupabase: client, viewerUserId: 'buyer-1' }))
        .rejects.toThrow('posts unavailable');
    });

    it('marks a detached purchase and gives it no thumbnail', async () => {
      const { client } = createSupabaseMock([
        createRow({ purchase_id: 'purchase-detached', bundle_id: null, post_id: null, post_visibility: null }),
        createRow(),
      ], {
        posts: postsTable(),
        post_resource_purchase_media: () => ({ data: [snapshotRow({ purchase_id: 'purchase-detached' })], error: null }),
      });

      const page = await listViewerUnlocks({ adminSupabase: client, viewerUserId: 'buyer-1' });

      expect(page.items[0]).toMatchObject({ detached: true, isNsfw: false, post: null });
      expect(page.items[1].detached).toBe(false);
    });

    it('reads covers, flags and payments once per page, never per row', async () => {
      const ids = ['11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111112'];
      const { client, reads } = createSupabaseMock([
        createRow({ purchase_id: ids[0] }),
        createRow({ purchase_id: ids[1], post_id: 'post-2' }),
      ], { posts: postsTable() });

      await listViewerUnlocks({ adminSupabase: client, viewerUserId: 'buyer-1' });

      const readsOf = (table: string) => reads.filter((read) => read.table === table);
      expect(readsOf('post_resource_purchase_media')).toHaveLength(1);
      expect(readsOf('post_resource_purchase_media')[0].filters.in.purchase_id).toEqual(ids);
      expect(readsOf('post_resource_bundle_purchases')).toHaveLength(1);
      expect(readsOf('post_resource_bundle_purchases')[0].filters.in.id).toEqual(ids);
      // One NSFW read, one unarchived check for the two live previews.
      expect(readsOf('posts')).toHaveLength(2);
      expect(loadMediaItems).toHaveBeenCalledTimes(1);
    });
  });

  describe('what the buyer paid', () => {
    const purchaseIds = {
      cash: '11111111-1111-4111-8111-111111111111',
      credits: '11111111-1111-4111-8111-111111111112',
      free: '11111111-1111-4111-8111-111111111113',
      legacyCredits: '11111111-1111-4111-8111-111111111114',
    };

    it('tells cash, credits and free apart from the purchase and its order reference', async () => {
      const { client } = createSupabaseMock([
        createRow({ purchase_id: purchaseIds.cash, purchase_price_usd_cents: 900 }),
        createRow({ purchase_id: purchaseIds.credits, purchase_price_usd_cents: 900 }),
        createRow({ purchase_id: purchaseIds.free, purchase_price_usd_cents: 0, access_mode: 'free', price_usd_cents: 0 }),
        createRow({ purchase_id: purchaseIds.legacyCredits, purchase_price_usd_cents: 500 }),
      ], {
        posts: postsTable(),
        post_resource_bundle_purchases: () => ({
          data: [
            { id: purchaseIds.cash, price_usd_cents: 900, amount_subunits: 75000, currency: 'INR', checkout: { razorpay_order_id: 'order_Qx81' } },
            { id: purchaseIds.credits, price_usd_cents: 900, amount_subunits: 900, currency: 'USD', checkout: { razorpay_order_id: 'credits_bundle_bundle-1_buyer-1' } },
            { id: purchaseIds.free, price_usd_cents: 0, amount_subunits: 0, currency: 'USD', checkout: { razorpay_order_id: 'free_bundle_abc' } },
            { id: purchaseIds.legacyCredits, price_usd_cents: 500, amount_subunits: 500, currency: 'USD', checkout: [{ razorpay_order_id: 'credits_asset_asset-1_buyer-1' }] },
          ],
          error: null,
        }),
      });

      const page = await listViewerUnlocks({ adminSupabase: client, viewerUserId: 'buyer-1' });

      const paid = page.items.map(({ paidWith, paidAmountSubunits, paidCurrency }) => ({ paidWith, paidAmountSubunits, paidCurrency }));
      expect(paid).toEqual([
        { paidWith: 'cash', paidAmountSubunits: 75000, paidCurrency: 'INR' },
        { paidWith: 'credits', paidAmountSubunits: 900, paidCurrency: null },
        { paidWith: 'free', paidAmountSubunits: null, paidCurrency: null },
        { paidWith: 'credits', paidAmountSubunits: 500, paidCurrency: null },
      ]);
    });

    it('reads a cash purchase in dollars as cash', async () => {
      const { client } = createSupabaseMock([createRow({ purchase_id: purchaseIds.cash })], {
        posts: postsTable(),
        post_resource_bundle_purchases: () => ({
          data: [{ id: purchaseIds.cash, price_usd_cents: 500, amount_subunits: 500, currency: 'USD', checkout: { razorpay_order_id: 'mobile_ios_2000000123' } }],
          error: null,
        }),
      });

      const page = await listViewerUnlocks({ adminSupabase: client, viewerUserId: 'buyer-1' });

      expect(page.items[0]).toMatchObject({ paidWith: 'cash', paidAmountSubunits: 500, paidCurrency: 'USD' });
    });

    it('falls back to the price in credits when the payment cannot be read', async () => {
      const { client } = createSupabaseMock([
        createRow({ purchase_id: purchaseIds.cash, purchase_price_usd_cents: 900 }),
        createRow({ purchase_id: purchaseIds.free, purchase_price_usd_cents: 0 }),
      ], {
        posts: postsTable(),
        post_resource_bundle_purchases: () => ({ data: null, error: new Error('purchases unavailable') }),
      });

      const page = await listViewerUnlocks({ adminSupabase: client, viewerUserId: 'buyer-1' });

      expect(page.items[0]).toMatchObject({ paidWith: 'credits', paidAmountSubunits: 900, paidCurrency: null });
      expect(page.items[1]).toMatchObject({ paidWith: 'free', paidAmountSubunits: null, paidCurrency: null });
    });
  });
});
