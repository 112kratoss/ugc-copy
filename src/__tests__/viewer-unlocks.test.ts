import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('@/lib/posts-server', () => ({
  getPostMediaKind: () => 'image',
  resolvePostMediaUrl: async (_client: unknown, row: { showcase_asset_path: string | null }) => (
    row.showcase_asset_path ? `https://media.example.com/${row.showcase_asset_path}` : null
  ),
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

function createSupabaseMock(rows: Array<Record<string, unknown>>) {
  const rpc = vi.fn(async () => ({ data: rows, error: null }));
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

describe('listViewerUnlocks', () => {
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
});
