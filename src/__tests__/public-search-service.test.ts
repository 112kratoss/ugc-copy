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

  it('never returns an NSFW-labelled post on Top or Posts, keeps text posts, and pages from the ranked rows', async () => {
    // search_public_posts leaves labelled posts out in SQL. The second row
    // stands for a post labelled between the ranked read and hydration, which
    // hydration covers ("Mature content") instead of dropping.
    const rows = [
      { post_id: '11111111-1111-4111-8111-111111111111', creator_user_id: 'creator-1', search_score: 9 },
      { post_id: '22222222-2222-4222-8222-222222222222', creator_user_id: 'creator-2', search_score: 8 },
      { post_id: '33333333-3333-4333-8333-333333333333', creator_user_id: 'creator-3', search_score: 7 },
      { post_id: '44444444-4444-4444-8444-444444444444', creator_user_id: 'creator-4', search_score: 6 },
    ];
    const [mediaPost, labelledPost, textPost, laterPost] = rows.map((row) => row.post_id);
    const rpc = vi.fn(async (name: string, args: { p_limit: number }) => {
      if (name === 'search_public_creators') return { data: [], error: null };
      if (name !== 'search_public_posts') throw new Error(`Unexpected RPC ${name}`);
      return { data: rows.slice(0, args.p_limit), error: null };
    });
    const getShowcaseFeedItemsByPostIds = vi.fn(async ({ postIds }: { postIds: string[] }) => postIds.map((id) => (
      id === labelledPost
        ? { id, isNsfw: true, nsfwRevealed: false, title: 'Mature content', postFormat: 'text' }
        : { id, isNsfw: false, postFormat: id === textPost ? 'text' : 'media' }
    )));
    const search = (type: 'top' | 'posts', viewerUserId: string | null) => searchPublicContent({
      query: 'lantern',
      normalizedQuery: 'lantern',
      type,
      cursor: null,
      limit: 3,
      viewerUserId,
      countryCode: null,
    }, {
      createServiceClient: vi.fn(() => ({ rpc }) as unknown as SupabaseClient),
      getMarketplaceResourceList: vi.fn(async () => ({
        items: [],
        pageInfo: { hasMore: false, nextOffset: null, offset: 0, limit: 6 },
      })) as never,
      getShowcaseFeedItemsByPostIds: getShowcaseFeedItemsByPostIds as never,
      loadBlockedCreatorIds: vi.fn(async () => new Set()) as never,
    });

    // Signed out on Top and signed in on Posts: the label hides a post from everyone.
    const top = await search('top', null);
    const posts = await search('posts', 'viewer-1');

    // The labelled post reached hydration in both, so its absence below is the filter's.
    expect(getShowcaseFeedItemsByPostIds.mock.calls.map(([options]) => options.postIds)).toEqual([
      [mediaPost, labelledPost, textPost, laterPost],
      [mediaPost, labelledPost, textPost],
    ]);
    expect(top.posts.items.map((item) => item.id)).toEqual([mediaPost, textPost, laterPost]);
    expect(top.posts.nextCursor).toBeNull();
    expect(posts.posts.items.map((item) => item.id)).toEqual([mediaPost, textPost]);
    // The keyset cursor is still the page's last ranked row, so the next page
    // continues after it: nothing repeats and nothing else is skipped.
    expect(decodePublicSearchCursor(posts.posts.nextCursor, 'posts')).toEqual({
      version: 1,
      type: 'posts',
      score: 7,
      id: textPost,
    });
    expect([...top.posts.items, ...posts.posts.items].some((item) => item.isNsfw)).toBe(false);
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

  // Decision 6 (2026-10-17): a recipe result counts paid sales and free unlocks apart.
  it('hands a recipe\'s paid sales and free unlocks out apart', async () => {
    const getMarketplaceResourceList = vi.fn(async () => ({
      items: [{
        id: 'recipe-1',
        postId: 'post-1',
        title: 'Free portrait recipe',
        summary: 'Summary',
        previewText: 'Preview',
        accessMode: 'free',
        priceUsdCents: 0,
        salesCount: 1,
        freeUnlockCount: 12,
        allowRemix: false,
        resourceKinds: ['prompt'],
        createdAt: '2026-10-01T00:00:00.000Z',
        seller: { id: 'seller-1', username: 'maker', name: 'Maker', avatar: null },
        post: null,
        priceQuote: null,
      }],
      pageInfo: { hasMore: false, nextOffset: null, offset: 0, limit: 2 },
    }));

    const result = await searchPublicContent({
      query: 'portrait',
      normalizedQuery: 'portrait',
      type: 'recipes',
      cursor: null,
      limit: 2,
      viewerUserId: null,
      countryCode: null,
    }, {
      createServiceClient: vi.fn(() => ({ rpc: vi.fn() }) as unknown as SupabaseClient),
      getMarketplaceResourceList: getMarketplaceResourceList as never,
    });

    expect(result.recipes.items).toEqual([expect.objectContaining({ salesCount: 1, freeUnlockCount: 12 })]);
  });
});
