import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { decodePublicSearchCursor, publicSearchCursorFilterMark } from '@/lib/public-search';
import { searchPublicContent } from '@/lib/public-search-service';

const SEARCH_BEGAN = new Date('2026-11-12T10:00:00.000Z');
const now = () => SEARCH_BEGAN;

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
      now,
    });

    expect(rpc).toHaveBeenCalledWith('search_public_posts', {
      p_query: 'product reveal',
      p_limit: 2,
      p_viewer_user_id: 'viewer-1',
      p_after_score: null,
      p_after_id: null,
      // Top, scored at the instant the search began.
      p_as_of: '2026-11-12T10:00:00.000Z',
      p_sort: 'top',
      p_after_created_at: null,
      // Nothing narrows it, and a misspelling may be corrected.
      p_made_with: null,
      p_media_kind: null,
      p_has_recipe: false,
      p_followed_only: false,
      p_correct: true,
    });
    expect(result.sort).toBe('top');
    expect(result.filters).toEqual({ madeWith: null, mediaKind: null, hasRecipe: false, following: false });
    expect(result.correctedQuery).toEqual({ posts: null, recipes: null });
    expect(result.exact).toBe(false);
    expect(result.entities).toEqual([]);
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
      // The next page is scored at the same instant.
      asOf: SEARCH_BEGAN.getTime(),
    });
  });

  describe('paging posts', () => {
    const FIRST = '11111111-1111-4111-8111-111111111111';
    const SECOND = '22222222-2222-4222-8222-222222222222';
    const rows = [
      { post_id: FIRST, creator_user_id: 'creator-1', search_score: 23.5, created_at: '2026-11-12T09:00:00.123456+00:00' },
      { post_id: SECOND, creator_user_id: 'creator-2', search_score: 13.1, created_at: '2026-11-10T09:00:00.654321+00:00' },
    ];
    function harness(clock: () => Date) {
      const rpc = vi.fn<(name: string, args: Record<string, unknown>) => Promise<{ data: typeof rows; error: null }>>(
        async () => ({ data: rows, error: null }),
      );
      const search = (options: Partial<Parameters<typeof searchPublicContent>[0]>) => searchPublicContent({
        query: 'portrait',
        normalizedQuery: 'portrait',
        type: 'posts',
        cursor: null,
        limit: 1,
        viewerUserId: null,
        countryCode: null,
        ...options,
      }, {
        createServiceClient: vi.fn(() => ({ rpc }) as unknown as SupabaseClient),
        getShowcaseFeedItemsByPostIds: vi.fn(async ({ postIds }: { postIds: string[] }) => postIds.map((id) => ({ id }))) as never,
        getMarketplaceResourceList: vi.fn(async () => ({
          items: [],
          pageInfo: { hasMore: false, nextOffset: null, offset: 0, limit: 6 },
        })) as never,
        loadBlockedCreatorIds: vi.fn(async () => new Set()) as never,
        now: clock,
      });
      const postArgs = () => rpc.mock.calls
        .filter(([name]) => name === 'search_public_posts')
        .map(([, args]) => args);
      return { search, postArgs };
    }

    it('scores the second page at the first page’s instant, however much later it is asked for', async () => {
      let clock = SEARCH_BEGAN;
      const { search, postArgs } = harness(() => clock);

      const pageOne = await search({});
      clock = new Date('2026-11-12T10:07:30.000Z');
      const cursor = decodePublicSearchCursor(pageOne.posts.nextCursor, 'posts');
      const pageTwo = await search({ cursor });

      expect(postArgs().map((args) => args.p_as_of)).toEqual([
        '2026-11-12T10:00:00.000Z',
        '2026-11-12T10:00:00.000Z',
      ]);
      expect(postArgs()[1]).toMatchObject({ p_after_score: 23.5, p_after_id: FIRST, p_after_created_at: null });
      // And the page after that carries the same instant on.
      expect(decodePublicSearchCursor(pageTwo.posts.nextCursor, 'posts')?.asOf).toBe(SEARCH_BEGAN.getTime());
    });

    it('scores a page asked for with a cursor issued before instants existed at its own request, and hands the instant on', async () => {
      const { search, postArgs } = harness(now);
      const page = await search({ cursor: { version: 1, type: 'posts', score: 8.25, id: SECOND } });

      expect(postArgs()[0]).toMatchObject({
        p_after_score: 8.25,
        p_after_id: SECOND,
        p_as_of: '2026-11-12T10:00:00.000Z',
        p_sort: 'top',
      });
      expect(decodePublicSearchCursor(page.posts.nextCursor, 'posts')?.asOf).toBe(SEARCH_BEGAN.getTime());
    });

    it('reads Latest newest first and pages it on created_at, to the microsecond', async () => {
      const { search, postArgs } = harness(now);

      const pageOne = await search({ sort: 'latest' });
      expect(pageOne.sort).toBe('latest');
      expect(postArgs()[0]).toMatchObject({ p_sort: 'latest', p_after_score: null, p_after_created_at: null });
      // A Top cursor would not decode here, and this one carries no score.
      expect(decodePublicSearchCursor(pageOne.posts.nextCursor, 'posts')).toBeNull();
      const cursor = decodePublicSearchCursor(pageOne.posts.nextCursor, 'posts', 'latest');
      expect(cursor).toEqual({
        version: 1,
        type: 'posts',
        sort: 'latest',
        createdAt: '2026-11-12T09:00:00.123456+00:00',
        id: FIRST,
      });

      await search({ sort: 'latest', cursor });
      expect(postArgs()[1]).toMatchObject({
        p_sort: 'latest',
        p_after_score: null,
        p_after_id: FIRST,
        p_after_created_at: '2026-11-12T09:00:00.123456+00:00',
      });
    });

    it('reads the Top tab and Creators ranked whatever sort is named', async () => {
      const { search, postArgs } = harness(now);
      const top = await search({ type: 'top', sort: 'latest' });
      const creators = await search({ type: 'creators', sort: 'latest' });

      expect(top.sort).toBe('top');
      expect(creators.sort).toBe('top');
      expect(postArgs()).toHaveLength(1);
      expect(postArgs()[0]).toMatchObject({ p_sort: 'top', p_as_of: '2026-11-12T10:00:00.000Z' });
    });
  });

  it('searches only creators on Top for a query of two characters, two emoji included', async () => {
    // Two emoji are four UTF-16 units; search_public_posts counts two
    // characters and raises, which failed the whole Top answer.
    // Creators are searched from two characters; posts, recipes, the recipes'
    // reading and the entities that open posts, from three.
    const rpc = vi.fn(async (name: string) => {
      if (name !== 'search_public_creators') throw new Error(`Unexpected RPC ${name}`);
      return { data: [], error: null };
    });
    const getMarketplaceResourceList = vi.fn();

    const result = await searchPublicContent({
      query: '\u{1F600}\u{1F600}',
      normalizedQuery: '\u{1F600}\u{1F600}',
      type: 'top',
      cursor: null,
      limit: 20,
      viewerUserId: null,
      countryCode: null,
    }, {
      createServiceClient: vi.fn(() => ({ rpc }) as unknown as SupabaseClient),
      getMarketplaceResourceList: getMarketplaceResourceList as never,
      getShowcaseFeedItemsByPostIds: vi.fn() as never,
      loadBlockedCreatorIds: vi.fn(async () => new Set()) as never,
    });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(getMarketplaceResourceList).not.toHaveBeenCalled();
    // No entity under three characters: pressing one opens Posts, which is not searched there.
    expect(result.entities).toEqual([]);
    expect(result.posts.items).toEqual([]);
    expect(result.recipes.items).toEqual([]);
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
      if (name === 'search_public_creators' || name === 'search_public_entities') return { data: [], error: null };
      if (name === 'search_recipes_corrected_query') return { data: null, error: null };
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
      now,
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
      asOf: SEARCH_BEGAN.getTime(),
    });
    expect([...top.posts.items, ...posts.posts.items].some((item) => item.isNsfw)).toBe(false);
  });

  // Both searches leave both sides of a block out before their limit (20261112103547), so this
  // pass now catches only a block made after the ranked read, and a blocked seller's recipe.
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
    // list drops after its query (a hidden post, a failed quality check), as
    // getMarketplaceResourceListBase does.
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

  it('asks the list for Latest recipes newest first, and pages them with a Latest cursor', async () => {
    const getMarketplaceResourceList = vi.fn(async ({ offset = 0, limit = 24 }: { offset?: number; limit?: number }) => ({
      items: [{ id: `recipe-${offset}`, seller: { id: 'seller-1' } }],
      pageInfo: { hasMore: true, nextOffset: offset + limit, offset, limit },
    }));
    const page = await searchPublicContent({
      query: 'portrait',
      normalizedQuery: 'portrait',
      type: 'recipes',
      sort: 'latest',
      cursor: null,
      limit: 20,
      viewerUserId: null,
      countryCode: null,
    }, {
      createServiceClient: vi.fn(() => ({ rpc: vi.fn() }) as unknown as SupabaseClient),
      getMarketplaceResourceList: getMarketplaceResourceList as never,
    });

    expect((getMarketplaceResourceList.mock.calls[0][0] as { sort?: string }).sort).toBe('recent');
    expect(page.sort).toBe('latest');
    expect(decodePublicSearchCursor(page.recipes.nextCursor, 'recipes', 'latest')).toEqual({
      version: 1, type: 'recipes', sort: 'latest', offset: 20,
    });
    // It pages Latest and nothing else.
    expect(decodePublicSearchCursor(page.recipes.nextCursor, 'recipes')).toBeNull();
  });

  it('asks the list for recipes by relevance, and offers no next page past the cursor\'s cap', async () => {
    const getMarketplaceResourceList = vi.fn(async ({ offset = 0, limit = 24 }: { offset?: number; limit?: number }) => ({
      items: [{ id: `recipe-${offset}`, seller: { id: 'seller-1' } }],
      pageInfo: { hasMore: true, nextOffset: offset + limit, offset, limit },
    }));
    const searchRecipes = (offset: number) => searchPublicContent({
      query: 'portrait',
      normalizedQuery: 'portrait',
      type: 'recipes',
      cursor: { version: 1, type: 'recipes', offset },
      limit: 20,
      viewerUserId: null,
      countryCode: null,
    }, {
      createServiceClient: vi.fn(() => ({ rpc: vi.fn() }) as unknown as SupabaseClient),
      getMarketplaceResourceList: getMarketplaceResourceList as never,
    });

    const early = await searchRecipes(920);
    const last = await searchRecipes(950);

    expect(getMarketplaceResourceList.mock.calls.map(([options]) => (options as { sort?: string }).sort))
      .toEqual(['relevance', 'relevance']);
    expect(decodePublicSearchCursor(early.recipes.nextCursor, 'recipes')).toEqual({ version: 1, type: 'recipes', offset: 940 });
    // 970 would be refused as invalid: the list ends here instead.
    expect(last.recipes.nextCursor).toBeNull();
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

  describe('entities, filters and the reading', () => {
    const POST = '11111111-1111-4111-8111-111111111111';
    const OTHER = '22222222-2222-4222-8222-222222222222';
    const NONE = { madeWith: null, mediaKind: null, hasRecipe: false, following: false };
    const recipe = (id: string) => ({
      id, postId: `post-${id}`, title: 'Portrait recipe', summary: '', previewText: '', accessMode: 'free',
      priceUsdCents: 0, salesCount: 0, freeUnlockCount: 0, allowRemix: false, resourceKinds: [],
      createdAt: '2026-11-12T00:00:00.000Z', seller: { id: 'seller-1', username: 'seller', name: 'Seller', avatar: null },
      post: null, priceQuote: { formatted: 'Free', currency: 'USD', amountSubunits: 0 },
    });
    function harness({
      posts = [{ post_id: POST, creator_user_id: 'creator-1', search_score: 9, created_at: '2026-11-12T09:00:00+00:00', corrected_query: null as string | null }],
      entities = [] as Array<Record<string, unknown>> | Error,
      recipesReadAs = null as string | null | Error,
      recipes = [] as Array<ReturnType<typeof recipe>>,
      hydrated = (ids: string[]) => ids.map((id) => ({ id })),
    } = {}) {
      const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
        if (name === 'search_public_creators') return { data: [], error: null };
        if (name === 'search_public_posts') return { data: posts.slice(0, Number(args.p_limit)), error: null };
        if (name === 'search_public_entities') {
          return entities instanceof Error ? { data: null, error: entities } : { data: entities, error: null };
        }
        if (name === 'search_recipes_corrected_query') {
          return recipesReadAs instanceof Error ? { data: null, error: recipesReadAs } : { data: recipesReadAs, error: null };
        }
        throw new Error(`Unexpected RPC ${name}`);
      });
      const getMarketplaceResourceList = vi.fn(async () => ({
        items: recipes,
        pageInfo: { hasMore: false, nextOffset: null, offset: 0, limit: 6 },
      }));
      const logEvent = vi.fn();
      const search = (options: Partial<Parameters<typeof searchPublicContent>[0]>) => searchPublicContent({
        query: 'portriat',
        normalizedQuery: 'portriat',
        type: 'top',
        cursor: null,
        limit: 20,
        viewerUserId: 'viewer-1',
        countryCode: null,
        ...options,
      }, {
        createServiceClient: vi.fn(() => ({ rpc }) as unknown as SupabaseClient),
        getShowcaseFeedItemsByPostIds: vi.fn(async ({ postIds }: { postIds: string[] }) => hydrated(postIds)) as never,
        getMarketplaceResourceList: getMarketplaceResourceList as never,
        loadBlockedCreatorIds: vi.fn(async () => new Set()) as never,
        logEvent,
        now,
      });
      const argsOf = (name: string) => rpc.mock.calls.filter(([called]) => called === name).map(([, args]) => args);
      return { search, argsOf, getMarketplaceResourceList, logEvent };
    }

    it('offers the Top tab the models and tools the query names, for this viewer, by the name posts print', async () => {
      const { search, argsOf } = harness({
        entities: [
          // Seen by the database under its bare key: named as posts name the model.
          { kind: 'model', key: 'kling-2.6', label: 'kling-2.6', post_count: 14, post_count_capped: false },
          { kind: 'tool', key: 'klingon-fx', label: 'Klingon FX', post_count: 1000, post_count_capped: true },
          // A model this app does not make keeps the name its posts gave it.
          { kind: 'model', key: 'niji-6', label: 'Niji 6', post_count: 2, post_count_capped: false },
        ],
      });
      const result = await search({ query: 'kling', normalizedQuery: 'kling' });
      expect(argsOf('search_public_entities')).toEqual([
        { p_query: 'kling', p_viewer_user_id: 'viewer-1', p_limit: 5, p_made_with: null },
      ]);
      expect(result.entities).toEqual([
        { kind: 'model', key: 'kling-2.6', label: 'Kling 2.6', postCount: 14, postCountCapped: false },
        { kind: 'tool', key: 'klingon-fx', label: 'Klingon FX', postCount: 1000, postCountCapped: true },
        { kind: 'model', key: 'niji-6', label: 'Niji 6', postCount: 2, postCountCapped: false },
      ]);
    });

    it('offers no entity for a two-character query: pressing one opens Posts, searched from three', async () => {
      for (const query of ['kl', '\u{1F600}\u{1F600}']) {
        const { search, argsOf } = harness({ entities: [{ kind: 'model', key: 'kling-2.6', label: 'Kling 2.6', post_count: 14, post_count_capped: false }] });
        const result = await search({ query, normalizedQuery: query });
        expect(argsOf('search_public_entities'), query).toEqual([]);
        expect(result.entities, query).toEqual([]);
      }
      const { search, argsOf } = harness();
      await search({ query: 'kli', normalizedQuery: 'kli' });
      expect(argsOf('search_public_entities')).toHaveLength(1);
    });

    it('answers the Top tab without entities when their read fails, and logs it', async () => {
      const failure = new Error('function search_public_entities does not exist');
      const { search, logEvent } = harness({ entities: failure, recipes: [recipe('r1')] });
      const result = await search({ query: 'kling', normalizedQuery: 'kling' });
      expect(result.entities).toEqual([]);
      // The rest of the answer stands.
      expect(result.posts.items).toEqual([{ id: POST }]);
      expect(result.recipes.items.map((item) => item.id)).toEqual(['r1']);
      expect(logEvent).toHaveBeenCalledWith('warn', 'public_search_entities_failed', { error: failure });
    });

    it('answers a Posts search narrowed to an entity when the entity’s name cannot be read: the filter is named by its key', async () => {
      const failure = new Error('statement timeout');
      const { search, argsOf, logEvent } = harness({ entities: failure });
      const result = await search({ type: 'posts', filters: { ...NONE, madeWith: 'model:kling-2.6' } });
      expect(argsOf('search_public_posts')[0]).toMatchObject({ p_made_with: 'model:kling-2.6' });
      expect(result.posts.items).toEqual([{ id: POST }]);
      expect(result.filters.madeWith).toEqual({ kind: 'model', key: 'kling-2.6', label: 'kling-2.6' });
      expect(logEvent).toHaveBeenCalledWith('warn', 'public_search_entities_failed', { error: failure });
    });

    it('offers entities on Top only: a Posts, Creators or Recipes search asks for none', async () => {
      for (const type of ['posts', 'creators', 'recipes'] as const) {
        const { search, argsOf } = harness();
        const result = await search({ type, query: 'kling', normalizedQuery: 'kling' });
        expect(argsOf('search_public_entities'), type).toEqual([]);
        expect(result.entities, type).toEqual([]);
      }
    });

    it('narrows a Posts search in the database and says what it applied, the entity by its name', async () => {
      const filters = { madeWith: 'model:kling-2.6', mediaKind: 'video' as const, hasRecipe: true, following: true };
      const { search, argsOf } = harness({
        entities: [{ kind: 'model', key: 'kling-2.6', label: 'Kling 2.6', post_count: 14, post_count_capped: false }],
      });
      const result = await search({ type: 'posts', sort: 'latest', filters });
      expect(argsOf('search_public_posts')[0]).toMatchObject({
        p_sort: 'latest', p_made_with: 'model:kling-2.6', p_media_kind: 'video', p_has_recipe: true,
        p_followed_only: true, p_correct: true,
      });
      // The filter's own entity, whatever the query, for the name it is shown under.
      expect(argsOf('search_public_entities')).toEqual([
        { p_query: null, p_viewer_user_id: 'viewer-1', p_limit: 1, p_made_with: 'model:kling-2.6' },
      ]);
      expect(result.filters).toEqual({
        madeWith: { kind: 'model', key: 'kling-2.6', label: 'Kling 2.6' },
        mediaKind: 'video', hasRecipe: true, following: true,
      });
      // The filter's entity is not an offer of entities.
      expect(result.entities).toEqual([]);
    });

    it('names a made-with entity no post shows this viewer by its key, never by a name they could not see', async () => {
      const { search } = harness({ entities: [], posts: [] });
      const result = await search({ type: 'posts', filters: { ...NONE, madeWith: 'tool:secretool' } });
      expect(result.filters.madeWith).toEqual({ kind: 'tool', key: 'secretool', label: 'secretool' });
      expect(result.posts.items).toEqual([]);
    });

    it('leaves the Top tab unnarrowed whatever filters a request names', async () => {
      const { search, argsOf } = harness();
      const result = await search({
        type: 'top',
        filters: { madeWith: 'model:kling-2.6', mediaKind: 'video', hasRecipe: true, following: true },
      });
      expect(argsOf('search_public_posts')[0]).toMatchObject({
        p_made_with: null, p_media_kind: null, p_has_recipe: false, p_followed_only: false,
      });
      expect(result.filters).toEqual(NONE);
    });

    it('marks a filtered search’s cursor with its filters, and an unfiltered one with nothing', async () => {
      const rows = [
        { post_id: POST, creator_user_id: 'creator-1', search_score: 9, created_at: '2026-11-12T09:00:00+00:00', corrected_query: null },
        { post_id: OTHER, creator_user_id: 'creator-2', search_score: 8, created_at: '2026-11-11T09:00:00+00:00', corrected_query: null },
      ];
      const video = { ...NONE, mediaKind: 'video' as const };
      const filtered = await harness({ posts: rows }).search({ type: 'posts', limit: 1, filters: video });
      const plain = await harness({ posts: rows }).search({ type: 'posts', limit: 1 });
      const exact = await harness({ posts: rows }).search({ type: 'posts', limit: 1, exact: true });

      const mark = (cursor: string | null) => decodePublicSearchCursor(cursor, 'posts')?.filters;
      expect(mark(filtered.posts.nextCursor)).toBe(publicSearchCursorFilterMark(video, false));
      expect(mark(filtered.posts.nextCursor)).toMatch(/^[0-9a-f]{8}$/);
      // As every cursor issued before filters: it still pages an unfiltered search.
      expect(mark(plain.posts.nextCursor)).toBeUndefined();
      // The reading is part of the search a cursor pages.
      expect(mark(exact.posts.nextCursor)).toBe(publicSearchCursorFilterMark(NONE, true));
      expect(mark(exact.posts.nextCursor)).not.toBe(mark(filtered.posts.nextCursor));
    });

    it('says how the posts and the recipes were read, each beside results it explains', async () => {
      const corrected = [{ post_id: POST, creator_user_id: 'creator-1', search_score: 9, created_at: '2026-11-12T09:00:00+00:00', corrected_query: 'portrait' }];
      const both = await harness({ posts: corrected, recipesReadAs: 'portraits', recipes: [recipe('r1')] }).search({});
      expect(both.correctedQuery).toEqual({ posts: 'portrait', recipes: 'portraits' });
      expect(both.exact).toBe(false);

      // Recipes corrected to a word no recipe then shows this viewer: nothing to show results "for".
      const noRecipes = await harness({ posts: corrected, recipesReadAs: 'portraits', recipes: [] }).search({});
      expect(noRecipes.correctedQuery).toEqual({ posts: 'portrait', recipes: null });

      // Posts whose every row was dropped after the ranked read (labelled since): no notice for none.
      const noPosts = await harness({
        posts: corrected,
        hydrated: (ids) => ids.map((id) => ({ id, isNsfw: true })),
      }).search({ type: 'posts' });
      expect(noPosts.posts.items).toEqual([]);
      expect(noPosts.correctedQuery).toEqual({ posts: null, recipes: null });

      // A database from before the reading was reported sends no column: read as typed.
      const before = await harness({
        posts: [{ post_id: POST, creator_user_id: 'creator-1', search_score: 9, created_at: '2026-11-12T09:00:00+00:00' } as never],
      }).search({ type: 'posts' });
      expect(before.correctedQuery.posts).toBeNull();
    });

    it('asks for the recipes’ reading only where recipes are searched', async () => {
      expect((await harness()).argsOf('search_recipes_corrected_query')).toEqual([]);
      for (const [type, asked] of [['top', 1], ['recipes', 1], ['posts', 0], ['creators', 0]] as const) {
        const { search, argsOf } = harness();
        await search({ type });
        expect(argsOf('search_recipes_corrected_query'), type).toHaveLength(asked);
      }
      const { search, argsOf } = harness();
      await search({ type: 'recipes' });
      expect(argsOf('search_recipes_corrected_query')).toEqual([{ p_query: 'portriat' }]);
    });

    it('reads the query as typed when asked: no correction for posts, and no recipes the list would find corrected', async () => {
      const { search, argsOf, getMarketplaceResourceList } = harness({
        posts: [], recipesReadAs: 'portrait', recipes: [recipe('r1')],
      });
      const result = await search({ exact: true });
      expect(argsOf('search_public_posts')[0]).toMatchObject({ p_correct: false });
      // The list corrects only when nothing holds the query as typed, so as typed it is the empty list.
      expect(getMarketplaceResourceList).not.toHaveBeenCalled();
      expect(result.recipes).toEqual({ items: [], nextCursor: null });
      expect(result.correctedQuery).toEqual({ posts: null, recipes: null });
      expect(result.exact).toBe(true);
    });

    it('still lists recipes on an exact search the list reads as typed anyway', async () => {
      const { search, getMarketplaceResourceList } = harness({ recipesReadAs: null, recipes: [recipe('r1')] });
      const result = await search({ type: 'recipes', exact: true });
      expect(getMarketplaceResourceList).toHaveBeenCalledTimes(1);
      expect(result.recipes.items.map((item) => item.id)).toEqual(['r1']);
    });

    it('lists no recipes on an exact search whose reading cannot be read: the list might correct under "as typed"', async () => {
      const failure = new Error('statement timeout');
      for (const type of ['recipes', 'top'] as const) {
        const { search, getMarketplaceResourceList, logEvent } = harness({ recipesReadAs: failure, recipes: [recipe('r1')] });
        const result = await search({ type, exact: true });
        expect(getMarketplaceResourceList, type).not.toHaveBeenCalled();
        expect(result.recipes, type).toEqual({ items: [], nextCursor: null });
        expect(result.correctedQuery, type).toEqual({ posts: null, recipes: null });
        expect(result.exact, type).toBe(true);
        expect(logEvent, type).toHaveBeenCalledWith('warn', 'public_search_recipes_reading_failed', { error: failure });
      }
    });

    it('keeps the recipes when their reading cannot be read: the notice is lost and the failure logged', async () => {
      const failure = new Error('function search_recipes_corrected_query does not exist');
      const { search, logEvent } = harness({ recipesReadAs: failure, recipes: [recipe('r1')] });
      const result = await search({ type: 'recipes' });
      expect(result.recipes.items.map((item) => item.id)).toEqual(['r1']);
      expect(result.correctedQuery.recipes).toBeNull();
      expect(logEvent).toHaveBeenCalledWith('warn', 'public_search_recipes_reading_failed', { error: failure });
    });
  });

  describe('related posts by meaning', () => {
    const post = (index: number) => `${index.toString().padStart(8, '0')}-1111-4111-8111-111111111111`;
    const lexicalRows = (count: number, corrected: string | null = null) => Array.from({ length: count }, (_, index) => ({
      post_id: post(index + 1),
      creator_user_id: `creator-${index + 1}`,
      search_score: 20 - index,
      created_at: '2026-11-12T09:00:00.000000+00:00',
      corrected_query: corrected,
    }));
    const relatedRows = [
      { post_id: post(91), creator_user_id: 'creator-91', similarity: 0.91 },
      { post_id: post(92), creator_user_id: 'creator-92', similarity: 0.88 },
      { post_id: post(93), creator_user_id: 'creator-93', similarity: 0.85 },
    ];

    function harness({
      lexical = lexicalRows(2),
      related = relatedRows as typeof relatedRows | null | Error,
      blocked = [] as string[],
      nsfw = [] as string[],
    } = {}) {
      const rpc = vi.fn(async (name: string) => {
        if (name === 'search_public_posts') return { data: lexical, error: null };
        if (name === 'search_public_creators' || name === 'search_public_entities') return { data: [], error: null };
        if (name === 'search_recipes_corrected_query') return { data: null, error: null };
        throw new Error(`Unexpected RPC ${name}`);
      });
      const client = { rpc } as unknown as SupabaseClient;
      const findRelatedPostRows = vi.fn<(
        client: SupabaseClient,
        options: {
          query: string;
          viewerUserId: string | null;
          viewerKey: string;
          guestNetworkKey?: string | null;
          excludePostIds: readonly string[];
          limit?: number;
        },
        dependencies?: unknown,
      ) => Promise<typeof relatedRows | null>>(async () => {
        if (related instanceof Error) throw related;
        return related;
      });
      const getShowcaseFeedItemsByPostIds = vi.fn(async ({ postIds }: { postIds: string[] }) => (
        postIds.map((id) => ({ id, isNsfw: nsfw.includes(id) }))
      ));
      const loadBlockedCreatorIds = vi.fn(async ({ creatorIds }: { creatorIds: string[] }) => (
        new Set(creatorIds.filter((id) => blocked.includes(id)))
      ));
      const logEvent = vi.fn();
      const runAfterResponse = vi.fn();
      const search = (options: Partial<Parameters<typeof searchPublicContent>[0]> = {}) => searchPublicContent({
        query: 'Ocean at dusk',
        normalizedQuery: 'Ocean at dusk',
        type: 'top',
        cursor: null,
        limit: 20,
        viewerUserId: 'viewer-1',
        countryCode: 'IN',
        // The client asked for related posts, and the route says who is asking.
        related: true,
        viewerKey: 'viewer-1',
        ...options,
      }, {
        createServiceClient: vi.fn(() => client),
        findRelatedPostRows: findRelatedPostRows as never,
        getShowcaseFeedItemsByPostIds: getShowcaseFeedItemsByPostIds as never,
        getMarketplaceResourceList: vi.fn(async () => ({
          items: [],
          pageInfo: { hasMore: false, nextOffset: null, offset: 0, limit: 6 },
        })) as never,
        loadBlockedCreatorIds: loadBlockedCreatorIds as never,
        logEvent,
        runAfterResponse,
        now,
      });
      return { search, client, findRelatedPostRows, getShowcaseFeedItemsByPostIds, loadBlockedCreatorIds, logEvent, runAfterResponse };
    }

    it('says which network a guest session asks from, for the allowance counted there', async () => {
      const { search, findRelatedPostRows } = harness();
      await search({ viewerUserId: 'guest-1', viewerKey: 'guest-1', guestNetworkKey: 'network-key' });
      expect(findRelatedPostRows.mock.calls[0][1]).toMatchObject({ viewerKey: 'guest-1', guestNetworkKey: 'network-key' });
    });

    it('adds them beside a thin answer, nearest first, hydrated as posts are, and leaves the answer’s own posts as they were', async () => {
      const { search, client, findRelatedPostRows, getShowcaseFeedItemsByPostIds, logEvent, runAfterResponse } = harness();
      const result = await search();
      expect(findRelatedPostRows).toHaveBeenCalledExactlyOnceWith(
        client,
        {
          query: 'Ocean at dusk',
          viewerUserId: 'viewer-1',
          // A new query is counted against the key the request is counted against.
          viewerKey: 'viewer-1',
          // Not a guest session: no network is counted beside the account.
          guestNetworkKey: null,
          // The posts the search itself returned never come back as related.
          excludePostIds: [post(1), post(2)],
          limit: 8,
        },
        { logEvent, runAfterResponse },
      );
      expect(result.related).toEqual({ posts: relatedRows.map((row) => ({ id: row.post_id, isNsfw: false })) });
      expect(getShowcaseFeedItemsByPostIds).toHaveBeenLastCalledWith({
        postIds: relatedRows.map((row) => row.post_id),
        viewerUserId: 'viewer-1',
        countryCode: 'IN',
      });
      // The same answer without the lookup: every other field is identical.
      const without = await harness({ related: null }).search();
      expect(without).not.toHaveProperty('related');
      const rest = { ...result };
      delete rest.related;
      expect(rest).toEqual(without);
      expect(result.posts.items.map((item) => item.id)).toEqual([post(1), post(2)]);
    });

    it('looks for them on a Posts search’s first page too, and when the search found nothing at all', async () => {
      const posts = harness();
      expect((await posts.search({ type: 'posts' })).related?.posts).toHaveLength(3);
      const nothing = harness({ lexical: [] });
      const result = await nothing.search({ type: 'posts' });
      expect(result.posts.items).toEqual([]);
      expect(result.related?.posts.map((item) => item.id)).toEqual(relatedRows.map((row) => row.post_id));
      expect(nothing.findRelatedPostRows.mock.calls[0][1]).toMatchObject({ excludePostIds: [] });
    });

    it('embeds the query as the posts search read it: a corrected misspelling is looked up corrected', async () => {
      const { search, findRelatedPostRows } = harness({ lexical: lexicalRows(1, 'ocean at dusk') });
      await search({ query: 'Ocaen at dusk', normalizedQuery: 'Ocaen at dusk' });
      expect(findRelatedPostRows.mock.calls[0][1]).toMatchObject({ query: 'ocean at dusk' });
    });

    it('looks for none unless the client asked: no read, no reservation, no call', async () => {
      for (const options of [{ related: false }, { related: undefined }]) {
        const { search, findRelatedPostRows, client } = harness();
        const result = await search(options);
        expect(findRelatedPostRows).not.toHaveBeenCalled();
        expect(result).not.toHaveProperty('related');
        // Nothing of search by meaning touched the database either.
        const rpcNames = (client.rpc as unknown as { mock: { calls: Array<[string]> } }).mock.calls.map(([name]) => name);
        expect(rpcNames.filter((name) => /embedding|related/.test(name))).toEqual([]);
      }
      // Asked, with nobody to count a new query against: none either.
      for (const viewerKey of [undefined, '', '  ']) {
        const { search, findRelatedPostRows } = harness();
        expect(await search({ viewerKey })).not.toHaveProperty('related');
        expect(findRelatedPostRows).not.toHaveBeenCalled();
      }
    });

    it('starts the lookup while the search’s own posts are being hydrated, not after', async () => {
      const { search, findRelatedPostRows, getShowcaseFeedItemsByPostIds } = harness();
      let finishHydration: () => void = () => undefined;
      const hydrating = new Promise<void>((resolve) => { finishHydration = resolve; });
      let lookupStartedDuringHydration = false;
      getShowcaseFeedItemsByPostIds.mockImplementationOnce(async ({ postIds }: { postIds: string[] }) => {
        // Give the event loop a turn: a lookup started beside this has been called by now.
        await new Promise((resolve) => setTimeout(resolve, 0));
        lookupStartedDuringHydration = findRelatedPostRows.mock.calls.length === 1;
        await hydrating;
        return postIds.map((id) => ({ id, isNsfw: false }));
      });
      const answering = search();
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(findRelatedPostRows).toHaveBeenCalledTimes(1);
      finishHydration();
      const result = await answering;
      expect(lookupStartedDuringHydration).toBe(true);
      expect(result.posts.items).toHaveLength(2);
      expect(result.related?.posts).toHaveLength(3);
    });

    it.each([
      ['six posts of its own', { lexical: lexicalRows(6) }, {}],
      ['a Posts page with more behind it', { lexical: lexicalRows(3) }, { type: 'posts' as const, limit: 2 }],
      ['a later page', {}, {
        type: 'posts' as const,
        cursor: { version: 1 as const, type: 'posts' as const, score: 3, id: post(7), asOf: SEARCH_BEGAN.getTime() },
      }],
      ['the Latest order', {}, { type: 'posts' as const, sort: 'latest' as const }],
      ['a filter', {}, { type: 'posts' as const, filters: { madeWith: null, mediaKind: 'video' as const, hasRecipe: false, following: false } }],
      ['the query read as typed', {}, { exact: true }],
      ['a Creators search', {}, { type: 'creators' as const }],
      ['a Recipes search', {}, { type: 'recipes' as const }],
      ['a query under three characters', { lexical: [] }, { query: 'oc', normalizedQuery: 'oc' }],
    ])('does not look for them with %s', async (_label, setup, options) => {
      const { search, findRelatedPostRows } = harness(setup);
      const result = await search(options);
      expect(findRelatedPostRows).not.toHaveBeenCalled();
      expect(result).not.toHaveProperty('related');
    });

    it('counts the posts it shows: five shown of six ranked, one labelled meanwhile, is a thin answer', async () => {
      const { search, findRelatedPostRows, getShowcaseFeedItemsByPostIds } = harness({ lexical: lexicalRows(6), nsfw: [post(3)] });
      // Six rows were ranked, so nothing is started beside the hydration...
      getShowcaseFeedItemsByPostIds.mockImplementationOnce(async ({ postIds }: { postIds: string[] }) => {
        expect(findRelatedPostRows).not.toHaveBeenCalled();
        return postIds.map((id) => ({ id, isNsfw: id === post(3) }));
      });
      const result = await search();
      // ...and once five are shown, the lookup runs after all.
      expect(result.posts.items).toHaveLength(5);
      expect(findRelatedPostRows).toHaveBeenCalledTimes(1);
      // The labelled one is excluded all the same: it was in the ranked read.
      expect(findRelatedPostRows.mock.calls[0][1]).toMatchObject({ excludePostIds: lexicalRows(6).map((row) => row.post_id) });
    });

    it('says they were looked for and none passed with an empty list, and says nothing when they could not be looked for', async () => {
      expect((await harness({ related: [] }).search()).related).toEqual({ posts: [] });
      expect(await harness({ related: null }).search()).not.toHaveProperty('related');
    });

    it('drops a creator blocked since the read, a post labelled since, and a post the answer already shows', async () => {
      const { search, getShowcaseFeedItemsByPostIds, loadBlockedCreatorIds } = harness({
        related: [
          { post_id: post(1), creator_user_id: 'creator-1', similarity: 0.95 },
          ...relatedRows,
        ],
        blocked: ['creator-92'],
        nsfw: [post(93)],
      });
      const result = await search();
      expect(loadBlockedCreatorIds).toHaveBeenLastCalledWith(expect.objectContaining({
        creatorIds: ['creator-91', 'creator-92', 'creator-93'],
        viewerUserId: 'viewer-1',
      }));
      // The blocked creator's post is never hydrated.
      expect(getShowcaseFeedItemsByPostIds).toHaveBeenLastCalledWith(expect.objectContaining({ postIds: [post(91), post(93)] }));
      expect(result.related).toEqual({ posts: [{ id: post(91), isNsfw: false }] });
    });

    it('holds them to eight', async () => {
      const many = Array.from({ length: 11 }, (_, index) => ({
        post_id: post(50 + index), creator_user_id: `creator-${50 + index}`, similarity: 0.95 - index / 100,
      }));
      const result = await harness({ related: many }).search();
      expect(result.related?.posts.map((item) => item.id)).toEqual(many.slice(0, 8).map((row) => row.post_id));
    });

    it('answers the search unchanged when the lookup throws, with a line in the log that names no query', async () => {
      const failure = new Error('socket closed');
      const { search, logEvent } = harness({ related: failure });
      const result = await search();
      expect(result).not.toHaveProperty('related');
      expect(result.posts.items.map((item) => item.id)).toEqual([post(1), post(2)]);
      expect(logEvent).toHaveBeenCalledWith('warn', 'public_search_related_failed', { error: failure });
      expect(JSON.stringify(logEvent.mock.calls)).not.toMatch(/ocean/i);
    });

    it('answers the search unchanged when hydrating them fails', async () => {
      const { search, getShowcaseFeedItemsByPostIds, logEvent } = harness();
      getShowcaseFeedItemsByPostIds
        .mockImplementationOnce(async ({ postIds }: { postIds: string[] }) => postIds.map((id) => ({ id, isNsfw: false })))
        .mockImplementationOnce(async () => { throw new Error('hydration failed'); });
      const result = await search();
      expect(result).not.toHaveProperty('related');
      expect(result.posts.items).toHaveLength(2);
      expect(logEvent).toHaveBeenCalledWith('warn', 'public_search_related_failed', expect.anything());
    });
  });

});
