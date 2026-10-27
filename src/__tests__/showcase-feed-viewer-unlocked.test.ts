import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { attachViewerStateToFeed, mergeViewerAssetState } from '@/lib/showcase-feed';
import { sanitizeShowcaseAssetSummary, type ShowcaseFeedItem, type ShowcaseFeedPage } from '@/lib/showcase';

/**
 * A recipe the viewer has bought or opened free kept its price on every card
 * (audit B-F2, 2026-10-27): the feed loaded the viewer's purchases only for
 * recipes that sell the remix, and used them only to open Remix. Every recipe
 * on the page now says whether this viewer has it, so a card can say
 * "Unlocked" in place of the price.
 */

type Row = Record<string, unknown>;

/** `user_blocks`, `post_saves` and `post_resource_bundle_purchases`, filtered as PostgREST filters them. */
function createAdminClient({
  bundlePurchases = [],
  failPurchases = false,
}: {
  bundlePurchases?: Array<{ buyer_user_id: string; bundle_id: string }>;
  failPurchases?: boolean;
} = {}) {
  const tables: Record<string, Row[]> = {
    user_blocks: [],
    post_saves: [],
    post_resource_bundle_purchases: bundlePurchases,
  };
  const purchaseQueries: Array<{ column: string; values: unknown[] }> = [];
  const from = vi.fn((table: string) => {
    const rows = tables[table];
    if (!rows) throw new Error(`Unexpected table: ${table}`);
    const filters: Array<(row: Row) => boolean> = [];
    const query = {
      select() {
        return query;
      },
      eq(column: string, value: unknown) {
        filters.push((row) => row[column] === value);
        return query;
      },
      in(column: string, values: unknown[]) {
        if (table === 'post_resource_bundle_purchases') purchaseQueries.push({ column, values });
        filters.push((row) => values.includes(row[column]));
        return query;
      },
      then<TResult1 = { data: Row[] | null; error: unknown }, TResult2 = never>(
        onfulfilled?: ((value: { data: Row[] | null; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) {
        const failed = failPurchases && table === 'post_resource_bundle_purchases';
        return Promise.resolve(failed
          ? { data: null, error: { message: 'timeout' } }
          : { data: rows.filter((row) => filters.every((filter) => filter(row))), error: null },
        ).then(onfulfilled, onrejected);
      },
    };
    return query;
  });

  return { client: { from } as unknown as SupabaseClient, from, purchaseQueries };
}

function recipe(id: string, postId: string, fields: Partial<NonNullable<ShowcaseFeedItem['asset']>> = {}) {
  return {
    id,
    postId,
    title: 'Launch hook recipe',
    accessMode: 'paid' as const,
    priceUsdCents: 250,
    previewText: 'The prompt behind it.',
    allowRemix: false,
    ...fields,
  };
}

function post(id: string, overrides: Partial<ShowcaseFeedItem> = {}): ShowcaseFeedItem {
  return {
    id,
    mediaUrl: `https://cdn.example.com/${id}.png`,
    mediaKind: 'image',
    model: 'nano-banana-2',
    title: id,
    prompt: '',
    body: '',
    category: 'image',
    postFormat: 'media',
    saveCount: 0,
    remixCount: 0,
    commentCount: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    creator: { id: 'creator-1', username: 'luna', name: 'Luna Studio', avatar: null },
    sourceKind: 'magicbooklet',
    sourceTool: null,
    generationId: `gen-${id}`,
    asset: null,
    canRemix: true,
    remixCapability: 'public',
    remixTarget: 'image',
    ...overrides,
  };
}

function page(items: ShowcaseFeedItem[]): ShowcaseFeedPage {
  return { items, pageInfo: { hasMore: false, nextOffset: null, limit: items.length, offset: 0 } };
}

describe('a recipe the viewer has, on the cards that list it', () => {
  const feed = page([
    // Bought, and its remix is not sold with it: this one never had its purchase read.
    post('post-1', { asset: recipe('bundle-1', 'post-1') }),
    // Opened free, sold with the remix.
    post('post-2', { asset: recipe('bundle-2', 'post-2', { accessMode: 'free', priceUsdCents: 0, allowRemix: true }) }),
    // Not the viewer's.
    post('post-3', { asset: recipe('bundle-3', 'post-3') }),
    // No recipe at all.
    post('post-4'),
  ]);

  it('marks every recipe the viewer has, in one read of their purchases', async () => {
    const admin = createAdminClient({
      bundlePurchases: [
        { buyer_user_id: 'viewer-1', bundle_id: 'bundle-1' },
        { buyer_user_id: 'viewer-1', bundle_id: 'bundle-2' },
        { buyer_user_id: 'someone-else', bundle_id: 'bundle-3' },
      ],
    });

    const result = await attachViewerStateToFeed(feed, 'viewer-1', admin.client as never);
    const byId = new Map(result.items.map((item) => [item.id, item]));

    expect(byId.get('post-1')?.asset?.viewerHasUnlocked).toBe(true);
    expect(byId.get('post-2')?.asset?.viewerHasUnlocked).toBe(true);
    expect(byId.get('post-3')?.asset?.viewerHasUnlocked).toBe(false);
    expect(byId.get('post-4')?.asset).toBeNull();
    // One query for the page's recipes, whether or not they sell the remix.
    expect(admin.purchaseQueries).toEqual([{ column: 'bundle_id', values: ['bundle-1', 'bundle-2', 'bundle-3'] }]);
  });

  it('claims nothing about a signed-out viewer', async () => {
    const admin = createAdminClient();

    const result = await attachViewerStateToFeed(feed, null, admin.client as never);

    for (const item of result.items) expect(item.asset?.viewerHasUnlocked).toBeUndefined();
  });

  it('claims nothing when the purchases cannot be read', async () => {
    const admin = createAdminClient({ failPurchases: true });

    const result = await attachViewerStateToFeed(feed, 'viewer-1', admin.client as never);

    for (const item of result.items) expect(item.asset?.viewerHasUnlocked).toBeUndefined();
  });

  it('keeps the answer through the sanitizer every listing goes through', () => {
    const asset = recipe('bundle-1', 'post-1', { viewerHasUnlocked: true });

    expect(sanitizeShowcaseAssetSummary(asset)?.viewerHasUnlocked).toBe(true);
    expect(sanitizeShowcaseAssetSummary({ ...asset, viewerHasUnlocked: false })?.viewerHasUnlocked).toBe(false);
    expect(sanitizeShowcaseAssetSummary(recipe('bundle-1', 'post-1'))).not.toHaveProperty('viewerHasUnlocked');
  });

  // The feed prices its page and reads the viewer's state side by side, then
  // takes each recipe from the priced copy: the viewer's answer must survive.
  it('keeps the viewer\'s answer on the priced recipe the feed merges back', () => {
    const priced = { ...recipe('bundle-1', 'post-1'), priceQuote: { currency: 'USD', formatted: '$2.50', amountSubunits: 250, note: null } };

    expect(mergeViewerAssetState(priced as never, { ...recipe('bundle-1', 'post-1'), viewerHasUnlocked: true }))
      .toEqual({ ...priced, viewerHasUnlocked: true });
    expect(mergeViewerAssetState(priced as never, recipe('bundle-1', 'post-1'))).toEqual(priced);
    expect(mergeViewerAssetState(null, null)).toBeNull();
  });
});
