import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { decodePublicSearchCursor } from '@/lib/public-search';
import { searchPublicContent } from '@/lib/public-search-service';

describe('public search service', () => {
  it('hydrates ranked post ids through the canonical feed mapper and emits a keyset cursor', async () => {
    const rpc = vi.fn(async (name: string) => {
      if (name !== 'search_public_posts') throw new Error(`Unexpected RPC ${name}`);
      return {
        data: [
          { post_id: '11111111-1111-4111-8111-111111111111', creator_user_id: 'creator-1', search_score: 8.25 },
          { post_id: '22222222-2222-4222-8222-222222222222', creator_user_id: 'creator-2', search_score: 7.5 },
        ],
        error: null,
      };
    });
    const getShowcaseFeedItemsByPostIds = vi.fn(async ({ postIds }: { postIds: string[] }) => (
      postIds.map((id) => ({ id }))
    ));

    const result = await searchPublicContent({
      query: 'product reveal',
      normalizedQuery: 'product reveal',
      type: 'posts',
      cursor: null,
      limit: 1,
      viewerUserId: 'viewer-1',
      countryCode: 'IN',
    }, {
      createServiceClient: vi.fn(() => ({ rpc }) as unknown as SupabaseClient),
      getShowcaseFeedItemsByPostIds: getShowcaseFeedItemsByPostIds as never,
      loadBlockedCreatorIds: vi.fn(async () => new Set()) as never,
    });

    expect(rpc).toHaveBeenCalledWith('search_public_posts', expect.objectContaining({
      p_query: 'product reveal',
      p_limit: 2,
      p_viewer_user_id: 'viewer-1',
    }));
    expect(getShowcaseFeedItemsByPostIds).toHaveBeenCalledWith({
      postIds: ['11111111-1111-4111-8111-111111111111'],
      viewerUserId: 'viewer-1',
      countryCode: 'IN',
    });
    expect(result.posts.items).toEqual([{ id: '11111111-1111-4111-8111-111111111111' }]);
    expect(decodePublicSearchCursor(result.posts.nextCursor, 'posts')).toEqual({
      version: 1,
      type: 'posts',
      score: 8.25,
      id: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('removes blocked creators before any result reaches the response', async () => {
    const rpc = vi.fn(async () => ({
      data: [
        {
          creator_user_id: 'creator-blocked',
          username: 'blocked',
          display_name: 'Blocked Creator',
          bio: null,
          avatar_url: null,
          public_post_count: 4,
          is_following: false,
          search_score: 5,
        },
        {
          creator_user_id: 'creator-visible',
          username: 'visible',
          display_name: 'Visible Creator',
          bio: null,
          avatar_url: null,
          public_post_count: 2,
          is_following: true,
          search_score: 4,
        },
      ],
      error: null,
    }));

    const result = await searchPublicContent({
      query: 'creator',
      normalizedQuery: 'creator',
      type: 'creators',
      cursor: null,
      limit: 20,
      viewerUserId: 'viewer-1',
      countryCode: null,
    }, {
      createServiceClient: vi.fn(() => ({ rpc }) as unknown as SupabaseClient),
      loadBlockedCreatorIds: vi.fn(async () => new Set(['creator-blocked'])) as never,
    });

    expect(result.creators.items).toEqual([expect.objectContaining({
      id: 'creator-visible',
      username: 'visible',
      isFollowing: true,
    })]);
  });

  it('pages recipes from the list\'s own offset, so a dropped row neither repeats a card nor ends the list', async () => {
    // Raw marketplace rows in list order. An ineligible row stands for one the
    // list drops after its query (a hidden post, a failed quality check, a
    // match only in resource text), as getMarketplaceResourceListBase does.
    const rows = [
      { id: 'recipe-1', eligible: true },
      { id: 'dropped-1', eligible: false },
      { id: 'recipe-2', eligible: true },
      { id: 'recipe-3', eligible: true },
      { id: 'dropped-2', eligible: false },
      { id: 'dropped-3', eligible: false },
      { id: 'recipe-4', eligible: true },
    ];
    // The list reads limit + 1 raw rows, returns at most `limit` eligible ones,
    // and reports the raw position after the rows it used.
    const getMarketplaceResourceList = vi.fn(async ({ offset = 0, limit = 24 }: { offset?: number; limit?: number }) => {
      const window = rows.slice(offset, offset + limit + 1);
      const hasMore = window.length > limit;
      const items: Array<{ id: string; seller: { id: string } }> = [];
      let consumed = 0;
      for (const row of window) {
        if (row.eligible && items.length >= limit) break;
        consumed += 1;
        if (row.eligible) items.push({ id: row.id, seller: { id: `seller-${row.id}` } });
      }
      return {
        items,
        pageInfo: { hasMore, nextOffset: hasMore ? offset + consumed : null, offset, limit },
      };
    });
    const searchRecipes = (cursor: ReturnType<typeof decodePublicSearchCursor>) => searchPublicContent({
      query: 'portrait',
      normalizedQuery: 'portrait',
      type: 'recipes',
      cursor,
      limit: 2,
      viewerUserId: null,
      countryCode: null,
    }, {
      createServiceClient: vi.fn(() => ({ rpc: vi.fn() }) as unknown as SupabaseClient),
      getMarketplaceResourceList: getMarketplaceResourceList as never,
    });

    const pageOne = await searchRecipes(null);
    const pageTwo = await searchRecipes(decodePublicSearchCursor(pageOne.recipes.nextCursor, 'recipes'));
    const pageThree = await searchRecipes(decodePublicSearchCursor(pageTwo.recipes.nextCursor, 'recipes'));

    expect(getMarketplaceResourceList.mock.calls.map(([options]) => [options.offset, options.limit])).toEqual([
      [0, 2],
      [3, 2],
      [6, 2],
    ]);
    expect(pageOne.recipes.items.map((item) => item.id)).toEqual(['recipe-1', 'recipe-2']);
    // Page two starts after the dropped row instead of repeating recipe-2.
    expect(pageTwo.recipes.items.map((item) => item.id)).toEqual(['recipe-3']);
    // A short page still offers more while the list reports more.
    expect(pageTwo.recipes.nextCursor).not.toBeNull();
    expect(pageThree.recipes.items.map((item) => item.id)).toEqual(['recipe-4']);
    expect(pageThree.recipes.nextCursor).toBeNull();
  });
});
