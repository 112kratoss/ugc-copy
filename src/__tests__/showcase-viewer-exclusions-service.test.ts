import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { SHOWCASE_VIEWER_EXCLUSIONS_MAX_ITEMS } from '@/lib/showcase';
import {
  getShowcaseViewerExclusionsForRoute,
  parseShowcaseViewerExclusionItems,
} from '@/lib/showcase-viewer-exclusions-service';

const VIEWER = '00000000-0000-4000-8000-000000000001';
const CREATOR_A = '00000000-0000-4000-8000-00000000000a';
const CREATOR_B = '00000000-0000-4000-8000-00000000000b';
const CREATOR_C = '00000000-0000-4000-8000-00000000000c';
const STRANGER = '00000000-0000-4000-8000-0000000000ff';
const post = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

type Row = Record<string, string>;
type Filter = { method: 'eq' | 'in'; column: string; value: unknown };

/** A stand-in for the service client: answers each table from the rows given, and keeps every filter it was asked with. */
function createClient(tables: {
  viewerBlocks?: Row[];
  creatorBlocks?: Row[];
  postFeedback?: Row[];
  creatorFeedback?: Row[];
  failing?: 'user_blocks' | 'feed_user_post_feedback' | 'feed_user_creator_feedback';
}) {
  const queries: Array<{ table: string; filters: Filter[] }> = [];
  const client = {
    from(table: string) {
      const filters: Filter[] = [];
      queries.push({ table, filters });
      const query = {
        select: () => query,
        eq(column: string, value: unknown) {
          filters.push({ method: 'eq', column, value });
          return query;
        },
        in(column: string, value: unknown[]) {
          filters.push({ method: 'in', column, value });
          if (tables.failing === table) return Promise.resolve({ data: null, error: { message: `${table} unavailable` } });
          const data = table === 'user_blocks'
            ? (filters.some((filter) => filter.column === 'blocker_user_id' && filter.method === 'eq')
              ? tables.viewerBlocks
              : tables.creatorBlocks)
            : table === 'feed_user_post_feedback'
              ? tables.postFeedback
              : tables.creatorFeedback;
          return Promise.resolve({ data: data ?? [], error: null });
        },
      };
      return query;
    },
  };
  return { client: client as unknown as SupabaseClient, queries };
}

describe('showcase viewer exclusions', () => {
  describe('reading what was asked', () => {
    it('takes a list of posts with their creators, each post once, and drops what is not an id', () => {
      expect(parseShowcaseViewerExclusionItems({
        items: [
          { postId: post(1), creatorId: CREATOR_A },
          { postId: post(1).toUpperCase(), creatorId: CREATOR_B },
          { postId: 'not-an-id', creatorId: CREATOR_A },
          { postId: post(2), creatorId: 'not-an-id' },
          { postId: post(3) },
          null,
          'post',
        ],
      })).toEqual([
        { postId: post(1), creatorId: CREATOR_A },
        { postId: post(2), creatorId: null },
        { postId: post(3), creatorId: null },
      ]);
    });

    it('says a body that is not a list of posts is not one', () => {
      expect(parseShowcaseViewerExclusionItems(null)).toBeNull();
      expect(parseShowcaseViewerExclusionItems({})).toBeNull();
      expect(parseShowcaseViewerExclusionItems({ items: 'post' })).toBeNull();
      expect(parseShowcaseViewerExclusionItems({ items: [] })).toEqual([]);
    });

    it('stops at two pages of the grid, however many posts it is sent', () => {
      const items = Array.from({ length: SHOWCASE_VIEWER_EXCLUSIONS_MAX_ITEMS + 25 }, (_, index) => ({
        postId: post(index + 1),
        creatorId: CREATOR_A,
      }));

      expect(parseShowcaseViewerExclusionItems({ items })).toHaveLength(SHOWCASE_VIEWER_EXCLUSIONS_MAX_ITEMS);
    });
  });

  it("answers with the blocks, either way, and the viewer's own feed preferences among the posts asked about", async () => {
    const { client, queries } = createClient({
      viewerBlocks: [{ blocked_user_id: CREATOR_A }],
      creatorBlocks: [{ blocker_user_id: CREATOR_B }],
      creatorFeedback: [{ creator_user_id: CREATOR_C }],
      postFeedback: [{ post_id: post(4) }, { post_id: post(4) }],
    });

    const result = await getShowcaseViewerExclusionsForRoute({
      adminSupabase: client,
      viewerUserId: VIEWER,
      items: [
        { postId: post(1), creatorId: CREATOR_A },
        { postId: post(2), creatorId: CREATOR_B },
        { postId: post(3), creatorId: CREATOR_C },
        { postId: post(4), creatorId: CREATOR_C },
      ],
    });

    expect(result).toEqual({
      ok: true,
      body: {
        blockedCreatorIds: [CREATOR_A, CREATOR_B],
        hiddenCreatorIds: [CREATOR_C],
        hiddenPostIds: [post(4)],
      },
    });
    // Every read is the viewer's own, and the preferences only while they are in force.
    const filtersOf = (table: string) => queries.filter((query) => query.table === table).map((query) => query.filters);
    expect(filtersOf('user_blocks')).toEqual([
      [
        { method: 'eq', column: 'blocker_user_id', value: VIEWER },
        { method: 'in', column: 'blocked_user_id', value: [CREATOR_A, CREATOR_B, CREATOR_C] },
      ],
      [
        { method: 'eq', column: 'blocked_user_id', value: VIEWER },
        { method: 'in', column: 'blocker_user_id', value: [CREATOR_A, CREATOR_B, CREATOR_C] },
      ],
    ]);
    expect(filtersOf('feed_user_post_feedback')).toEqual([[
      { method: 'eq', column: 'user_id', value: VIEWER },
      { method: 'eq', column: 'is_active', value: true },
      { method: 'in', column: 'post_id', value: [post(1), post(2), post(3), post(4)] },
    ]]);
    expect(filtersOf('feed_user_creator_feedback')).toEqual([[
      { method: 'eq', column: 'user_id', value: VIEWER },
      { method: 'eq', column: 'is_active', value: true },
      { method: 'in', column: 'creator_user_id', value: [CREATOR_A, CREATOR_B, CREATOR_C] },
    ]]);
  });

  // Nothing about anyone the page did not ask about leaves the server, whatever a query hands back.
  it('never answers about a creator or a post it was not asked about', async () => {
    const { client } = createClient({
      viewerBlocks: [{ blocked_user_id: STRANGER }, { blocked_user_id: CREATOR_A }],
      creatorBlocks: [{ blocker_user_id: STRANGER }],
      creatorFeedback: [{ creator_user_id: STRANGER }],
      postFeedback: [{ post_id: post(99) }],
    });

    const result = await getShowcaseViewerExclusionsForRoute({
      adminSupabase: client,
      viewerUserId: VIEWER,
      items: [{ postId: post(1), creatorId: CREATOR_A }],
    });

    expect(result).toEqual({
      ok: true,
      body: { blockedCreatorIds: [CREATOR_A], hiddenCreatorIds: [], hiddenPostIds: [] },
    });
  });

  it("does not ask about the viewer's own posts, or about creators when no post names one", async () => {
    const { client, queries } = createClient({ postFeedback: [{ post_id: post(2) }] });

    const result = await getShowcaseViewerExclusionsForRoute({
      adminSupabase: client,
      viewerUserId: VIEWER,
      items: [{ postId: post(1), creatorId: VIEWER }, { postId: post(2), creatorId: null }],
    });

    expect(result).toEqual({
      ok: true,
      body: { blockedCreatorIds: [], hiddenCreatorIds: [], hiddenPostIds: [post(2)] },
    });
    expect(queries.map((query) => query.table)).toEqual(['feed_user_post_feedback']);
  });

  it('reads nothing when it is asked about nothing', async () => {
    const { client, queries } = createClient({});

    await expect(getShowcaseViewerExclusionsForRoute({ adminSupabase: client, viewerUserId: VIEWER, items: [] }))
      .resolves.toEqual({ ok: true, body: { blockedCreatorIds: [], hiddenCreatorIds: [], hiddenPostIds: [] } });
    expect(queries).toEqual([]);
  });

  // A page that is told "nothing to hide" keeps a blocked creator on screen, so a
  // read that failed is an error and never an empty answer.
  it.each(['user_blocks', 'feed_user_post_feedback', 'feed_user_creator_feedback'] as const)(
    'fails rather than answer "nothing" when %s cannot be read',
    async (failing) => {
      const { client } = createClient({ failing });

      await expect(getShowcaseViewerExclusionsForRoute({
        adminSupabase: client,
        viewerUserId: VIEWER,
        items: [{ postId: post(1), creatorId: CREATOR_A }],
      })).rejects.toMatchObject({ message: `${failing} unavailable` });
    },
  );
});
