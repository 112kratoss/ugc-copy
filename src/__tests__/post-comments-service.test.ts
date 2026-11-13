import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  POST_COMMENT_MAX_SCAN_ITERATIONS,
  createPostCommentForRoute,
  listPostCommentsForRoute,
  normalizePostCommentBody,
  normalizePostCommentId,
  normalizePostCommentLimit,
  normalizePostCommentSort,
  parsePostCommentUpdate,
  removePostCommentForRoute,
  updatePostCommentForRoute,
} from '@/lib/post-comments-service';

type Row = Record<string, unknown>;

const POST_ID = '10000000-0000-4000-8000-000000000001';
const POST_OWNER_ID = '20000000-0000-4000-8000-000000000002';
const AUTHOR_ID = '30000000-0000-4000-8000-000000000003';
const STRANGER_ID = '40000000-0000-4000-8000-000000000004';
const COMMENT_ID = '50000000-0000-4000-8000-000000000005';
const REPLY_ID = '60000000-0000-4000-8000-000000000006';

const PUBLIC_POST = {
  id: POST_ID,
  user_id: POST_OWNER_ID,
  comment_count: 2,
  visibility: 'public',
  archived_at: null,
  review_status: 'visible',
};

function comment(overrides: Row = {}): Row {
  return {
    id: COMMENT_ID,
    post_id: POST_ID,
    user_id: AUTHOR_ID,
    parent_comment_id: null,
    body: 'a thoughtful comment',
    status: 'active',
    reply_count: 0,
    created_at: '2026-07-27T10:00:00.000Z',
    ...overrides,
  };
}

function createClient({
  posts = [PUBLIC_POST] as Row[],
  comments = [comment()] as Row[],
  profiles = [
    { id: AUTHOR_ID, username: 'author', display_name: 'The Author', avatar_url: null },
  ] as Row[],
  userBlocks = [] as Array<{ blocker_user_id: string; blocked_user_id: string }>,
  reactions = [] as Array<{ comment_id: string; user_id: string; reaction: string }>,
  rateLimitAllowed = true,
} = {}) {
  const state = {
    comments: [...comments],
    reactions: [...reactions],
    rpcCalls: [] as Array<{ name: string; args: Row }>,
  };
  // The four functions of 20261113191038, as far as the service can tell them
  // apart: each changes the row the service then reads back.
  const patchComment = (id: unknown, patch: Row) => {
    state.comments = state.comments.map((row) => (row.id === id ? { ...row, ...patch } : row));
  };

  const rpc = vi.fn(async (name: string, args: Row) => {
    state.rpcCalls.push({ name, args });

    if (name === 'create_post_comment') {
      return {
        data: [{
          comment_id: 'created-comment-id',
          created_at: '2026-07-27T12:00:00.000Z',
          comment_count: 3,
          parent_reply_count: args.p_parent_comment_id ? 1 : 0,
        }],
        error: null,
      };
    }

    if (name === 'set_post_comment_status') {
      return { data: [{ changed: true, comment_count: 1 }], error: null };
    }

    if (name === 'set_post_comment_reaction') {
      state.reactions = state.reactions.filter((row) => !(
        row.comment_id === args.p_comment_id && row.user_id === args.p_user_id
      ));
      if (args.p_reaction !== 'none') {
        state.reactions.push({
          comment_id: String(args.p_comment_id),
          user_id: String(args.p_user_id),
          reaction: String(args.p_reaction),
        });
      }
      const likeCount = state.reactions.filter((row) => (
        row.comment_id === args.p_comment_id && row.reaction === 'like'
      )).length;
      patchComment(args.p_comment_id, { like_count: likeCount });
      return {
        data: [{ like_count: likeCount, viewer_reaction: args.p_reaction === 'none' ? null : args.p_reaction }],
        error: null,
      };
    }

    if (name === 'edit_post_comment') {
      patchComment(args.p_comment_id, {
        body: args.p_body, edited_at: '2026-11-13T12:00:00.000Z', hearted_at: null,
      });
      return { data: [{ body: args.p_body, edited_at: '2026-11-13T12:00:00.000Z', changed: true }], error: null };
    }

    if (name === 'set_post_comment_heart') {
      patchComment(args.p_comment_id, { hearted_at: args.p_hearted ? '2026-11-13T12:00:00.000Z' : null });
      return { data: [{ hearted: args.p_hearted }], error: null };
    }

    if (name === 'set_post_comment_pin') {
      const previous = state.comments.find((row) => row.pinned_at && row.id !== args.p_comment_id);
      if (args.p_pinned && previous) patchComment(previous.id, { pinned_at: null });
      patchComment(args.p_comment_id, { pinned_at: args.p_pinned ? '2026-11-13T12:00:00.000Z' : null });
      return {
        data: [{ pinned: args.p_pinned, unpinned_comment_id: args.p_pinned ? previous?.id ?? null : null }],
        error: null,
      };
    }

    return {
      data: {
        allowed: rateLimitAllowed,
        limit: 20,
        remaining: rateLimitAllowed ? 19 : 0,
        retryAfterSeconds: rateLimitAllowed ? 0 : 120,
        resetAt: '2026-07-27T12:10:00.000Z',
      },
      error: null,
    };
  });

  const tableReads: Record<string, number> = {};

  function from(table: string) {
    tableReads[table] = (tableReads[table] ?? 0) + 1;
    const eqFilters: Record<string, unknown> = {};
    const isFilters: Record<string, unknown> = {};
    const inFilters: Record<string, unknown[]> = {};
    const notNullColumns: string[] = [];
    let orFilter: string | null = null;
    let limitCount: number | null = null;

    const source = (): Row[] => {
      if (table === 'posts') return posts;
      if (table === 'post_comments') return state.comments;
      if (table === 'profiles') return profiles;
      if (table === 'user_blocks') return userBlocks as unknown as Row[];
      if (table === 'post_comment_reactions') return state.reactions as unknown as Row[];
      return [];
    };

    const filteredRows = () => source().filter((row) => (
      Object.entries(eqFilters).every(([column, value]) => row[column] === value)
      && Object.entries(isFilters).every(([column, value]) => (row[column] ?? null) === value)
      && Object.entries(inFilters).every(([column, values]) => values.includes(row[column]))
      && notNullColumns.every((column) => (row[column] ?? null) !== null)
      && (orFilter !== 'status.eq.active,reply_count.gt.0'
        || row.status === 'active'
        || Number(row.reply_count ?? 0) > 0)
    ));

    const query = {
      select: () => query,
      eq(column: string, value: unknown) {
        eqFilters[column] = value;
        return query;
      },
      is(column: string, value: unknown) {
        isFilters[column] = value;
        return query;
      },
      in(column: string, values: unknown[]) {
        inFilters[column] = values;
        return query;
      },
      // Only `.not(column, 'is', null)` is asked of it: the pinned comment's read.
      not(column: string) {
        notNullColumns.push(column);
        return query;
      },
      or(expression: string) {
        orFilter = expression;
        return query;
      },
      order: () => query,
      // F9's viewer block load reads the whole list with a cap, so the stub
      // needs `limit()`; without it the call throws and the listing 500s.
      limit(count: number) {
        limitCount = count;
        return query;
      },
      async range(start: number, end: number) {
        return { data: filteredRows().slice(start, end + 1), error: null };
      },
      async maybeSingle() {
        const row = filteredRows()[0] ?? null;
        if (!row || table !== 'post_comments') return { data: row, error: null };
        const relatedPost = posts.find((post) => post.id === row.post_id) ?? null;
        return { data: { ...row, posts: relatedPost }, error: null };
      },
      then(resolve: (value: { data: Row[]; error: null }) => unknown) {
        const rows = limitCount === null ? filteredRows() : filteredRows().slice(0, limitCount);
        return Promise.resolve({ data: rows, error: null }).then(resolve);
      },
    };

    return query;
  }

  return { client: { from, rpc } as unknown as SupabaseClient, state, tableReads };
}

describe('post comments service', () => {
  describe('input normalization', () => {
    it('defaults to the top sort and clamps page size', () => {
      expect(normalizePostCommentSort('newest')).toBe('newest');
      expect(normalizePostCommentSort('nonsense')).toBe('top');
      expect(normalizePostCommentLimit('500')).toBe(50);
      expect(normalizePostCommentLimit('nonsense')).toBe(20);
      expect(normalizePostCommentId(COMMENT_ID)).toBe(COMMENT_ID);
      expect(normalizePostCommentId('not-a-uuid')).toBeNull();
    });

    it('rejects blank and oversized comment bodies', () => {
      expect(normalizePostCommentBody('  hello  ')).toBe('hello');
      expect(normalizePostCommentBody('   ')).toBeNull();
      expect(normalizePostCommentBody('x'.repeat(2001))).toBeNull();
    });
  });

  describe('listing', () => {
    it('rejects malformed post and parent identifiers before querying uuid columns', async () => {
      const createAdminSupabase = vi.fn();

      const invalidPost = await listPostCommentsForRoute({
        postId: 'not-a-uuid',
        viewerUserId: null,
        createAdminSupabase,
      });
      const invalidParent = await listPostCommentsForRoute({
        postId: POST_ID,
        viewerUserId: null,
        parentId: 'not-a-uuid',
        createAdminSupabase,
      });

      expect(invalidPost).toMatchObject({ ok: false, status: 400 });
      expect(invalidParent).toMatchObject({ ok: false, status: 400 });
      expect(createAdminSupabase).not.toHaveBeenCalled();
    });

    it('returns top-level comments with their author profile', async () => {
      const { client } = createClient();

      const result = await listPostCommentsForRoute({
        postId: POST_ID,
        viewerUserId: null,
        createAdminSupabase: () => client,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.body.commentCount).toBe(2);
      expect(result.body.postCreatorId).toBe(POST_OWNER_ID);
      expect(result.body.comments).toHaveLength(1);
      expect(result.body.comments[0]).toMatchObject({
        id: COMMENT_ID,
        body: 'a thoughtful comment',
        status: 'active',
        author: { id: AUTHOR_ID, username: 'author', displayName: 'The Author' },
      });
    });

    it('withholds the body and author of a removed comment so replies survive', async () => {
      const { client } = createClient({
        comments: [comment({ status: 'removed_by_author', reply_count: 2 })],
      });

      const result = await listPostCommentsForRoute({
        postId: POST_ID,
        viewerUserId: null,
        createAdminSupabase: () => client,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.body.comments[0]).toMatchObject({
        status: 'removed_by_author',
        body: '',
        author: null,
        replyCount: 2,
      });
    });

    it('drops comments from creators the viewer has blocked', async () => {
      const { client } = createClient({
        comments: [comment(), comment({ id: REPLY_ID, user_id: STRANGER_ID })],
        userBlocks: [{ blocker_user_id: POST_OWNER_ID, blocked_user_id: STRANGER_ID }],
      });

      const result = await listPostCommentsForRoute({
        postId: POST_ID,
        viewerUserId: POST_OWNER_ID,
        createAdminSupabase: () => client,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.body.comments.map((item) => item.id)).toEqual([COMMENT_ID]);
    });

    it('reads the viewer block list once, however many batches the scan walks', async () => {
      // F9: loadBlockedCreatorIds issues two user_blocks queries, and it used
      // to be called per batch inside an uncapped loop. The block set belongs
      // to the viewer, not the batch, so the whole scan should cost two reads
      // no matter how far it walks.
      const blockedId = STRANGER_ID;
      const blockedComments = Array.from({ length: 60 }, (_, index) => comment({
        id: `60000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`,
        user_id: blockedId,
      }));
      const { client, tableReads } = createClient({
        comments: [...blockedComments, comment({ id: COMMENT_ID, user_id: AUTHOR_ID })],
        userBlocks: [{ blocker_user_id: POST_OWNER_ID, blocked_user_id: blockedId }],
      });

      const result = await listPostCommentsForRoute({
        postId: POST_ID,
        viewerUserId: POST_OWNER_ID,
        createAdminSupabase: () => client,
      });

      expect(result.ok).toBe(true);
      // Two reads: outgoing blocks and incoming blocks. Three or more batches
      // were walked to reach the visible comment.
      expect(tableReads.user_blocks).toBe(2);
      expect(tableReads.post_comments).toBeGreaterThan(2);
    });

    it('bounds the scan and reports hasMore rather than claiming the thread ended', async () => {
      // Every comment is blocked, so the scan can never fill a page. Before the
      // cap this walked the entire thread; now it stops and tells the client to
      // continue, which keeps the cap a bound rather than a silent truncation.
      const blockedId = STRANGER_ID;
      const blockedComments = Array.from({ length: 400 }, (_, index) => comment({
        id: `70000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`,
        user_id: blockedId,
      }));
      const { client, tableReads } = createClient({
        comments: blockedComments,
        userBlocks: [{ blocker_user_id: POST_OWNER_ID, blocked_user_id: blockedId }],
      });

      const result = await listPostCommentsForRoute({
        postId: POST_ID,
        viewerUserId: POST_OWNER_ID,
        createAdminSupabase: () => client,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.body.comments).toEqual([]);
      expect(result.body.pageInfo.hasMore).toBe(true);
      expect(result.body.pageInfo.nextOffset).toBeGreaterThan(0);
      // The cap, not the thread length, decided when to stop.
      expect(tableReads.post_comments).toBeLessThanOrEqual(POST_COMMENT_MAX_SCAN_ITERATIONS + 1);
    });

    it('scans past a fully blocked raw page to return later visible comments', async () => {
      const blockedId = STRANGER_ID;
      const blockedComments = Array.from({ length: 21 }, (_, index) => comment({
        id: `50000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`,
        user_id: blockedId,
      }));
      const visibleComment = comment({ id: COMMENT_ID, user_id: AUTHOR_ID });
      const { client } = createClient({
        comments: [...blockedComments, visibleComment],
        userBlocks: [{ blocker_user_id: POST_OWNER_ID, blocked_user_id: blockedId }],
      });

      const result = await listPostCommentsForRoute({
        postId: POST_ID,
        viewerUserId: POST_OWNER_ID,
        createAdminSupabase: () => client,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.body.comments.map((item) => item.id)).toEqual([COMMENT_ID]);
      expect(result.body.pageInfo.hasMore).toBe(false);
    });

    it.each(['outgoing', 'incoming', 'beyond-cap'])('denies the whole creator thread for an %s block before reading comments', async direction => {
      const filler = direction === 'beyond-cap'
        ? Array.from({ length: 5001 }, (_, index) => ({ blocker_user_id: STRANGER_ID, blocked_user_id: `unrelated-${index}` }))
        : [];
      const { client, tableReads } = createClient({
        userBlocks: [...filler, direction === 'incoming'
          ? { blocker_user_id: POST_OWNER_ID, blocked_user_id: STRANGER_ID }
          : { blocker_user_id: STRANGER_ID, blocked_user_id: POST_OWNER_ID }],
      });
      expect(await listPostCommentsForRoute({
        postId: POST_ID, viewerUserId: STRANGER_ID, createAdminSupabase: () => client,
      })).toMatchObject({ ok: false, status: 404 });
      expect(tableReads.post_comments ?? 0).toBe(0);
    });

    it('answers likes, the reader\'s own reaction, the heart, the pin and the edit stamp, and never the dislikes', async () => {
      const { client } = createClient({
        comments: [comment({
          like_count: 4,
          dislike_count: 9,
          edited_at: '2026-11-01T08:00:00.000Z',
          hearted_at: '2026-11-02T08:00:00.000Z',
        })],
        reactions: [
          { comment_id: COMMENT_ID, user_id: STRANGER_ID, reaction: 'dislike' },
          { comment_id: COMMENT_ID, user_id: POST_OWNER_ID, reaction: 'like' },
        ],
      });

      const read = async (viewerUserId: string | null) => {
        const result = await listPostCommentsForRoute({
          postId: POST_ID, viewerUserId, createAdminSupabase: () => client,
        });
        if (!result.ok) throw new Error('the thread did not load');
        return result.body.comments[0];
      };

      expect(await read(null)).toMatchObject({
        likeCount: 4,
        viewerReaction: null,
        editedAt: '2026-11-01T08:00:00.000Z',
        hearted: true,
        pinned: false,
      });
      // Each reader gets their own reaction, never another's.
      expect((await read(STRANGER_ID)).viewerReaction).toBe('dislike');
      expect((await read(POST_OWNER_ID)).viewerReaction).toBe('like');
      // How many disliked it stays on the server.
      expect(JSON.stringify(await read(STRANGER_ID))).not.toMatch(/dislikeCount|dislike_count|"9"|:9[,}]/);
    });

    it('shows a removed comment with no likes, heart, pin or edit stamp', async () => {
      const { client } = createClient({
        comments: [comment({
          status: 'removed_by_author', reply_count: 1, like_count: 7, edited_at: '2026-11-01T08:00:00.000Z',
        })],
        reactions: [{ comment_id: COMMENT_ID, user_id: STRANGER_ID, reaction: 'like' }],
      });

      const result = await listPostCommentsForRoute({
        postId: POST_ID, viewerUserId: STRANGER_ID, createAdminSupabase: () => client,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.body.comments[0]).toMatchObject({
        body: '', author: null, likeCount: 0, viewerReaction: null, editedAt: null, hearted: false, pinned: false,
      });
    });

    it('leads the first page with the pinned comment, beyond the page\'s limit, and no later page repeats it', async () => {
      const rows = Array.from({ length: 5 }, (_, index) => comment({
        id: `50000000-0000-4000-8000-00000000000${index + 1}`,
        body: `comment ${index + 1}`,
      }));
      rows[3] = { ...rows[3], pinned_at: '2026-11-03T08:00:00.000Z' };
      const { client } = createClient({ comments: rows });

      const page = async (offset: number) => {
        const result = await listPostCommentsForRoute({
          postId: POST_ID, viewerUserId: null, limit: 2, offset, createAdminSupabase: () => client,
        });
        if (!result.ok) throw new Error('the thread did not load');
        return result.body;
      };

      const first = await page(0);
      expect(first.comments.map((item) => item.body)).toEqual(['comment 4', 'comment 1', 'comment 2']);
      expect(first.comments.map((item) => item.pinned)).toEqual([true, false, false]);
      // Offsets count the unpinned comments only, so the next page starts where this one stopped.
      expect(first.pageInfo).toMatchObject({ hasMore: true, nextOffset: 2 });
      const second = await page(2);
      expect(second.comments.map((item) => item.body)).toEqual(['comment 3', 'comment 5']);
      expect(second.pageInfo.hasMore).toBe(false);
    });

    it('keeps a pinned comment from a reader who blocked its author, and out of a reply list', async () => {
      const { client } = createClient({
        comments: [
          comment({ pinned_at: '2026-11-03T08:00:00.000Z' }),
          comment({ id: REPLY_ID, parent_comment_id: COMMENT_ID, body: 'a reply' }),
        ],
        userBlocks: [{ blocker_user_id: STRANGER_ID, blocked_user_id: AUTHOR_ID }],
      });

      const blocked = await listPostCommentsForRoute({
        postId: POST_ID, viewerUserId: STRANGER_ID, createAdminSupabase: () => client,
      });
      expect(blocked.ok && blocked.body.comments).toEqual([]);

      const replies = await listPostCommentsForRoute({
        postId: POST_ID, viewerUserId: null, parentId: COMMENT_ID, createAdminSupabase: () => client,
      });
      expect(replies.ok && replies.body.comments.map((item) => item.id)).toEqual([REPLY_ID]);
    });

    it('reports 404 for a post that is not publicly visible', async () => {
      const { client } = createClient({ posts: [{ ...PUBLIC_POST, visibility: 'private' }] });

      const result = await listPostCommentsForRoute({
        postId: POST_ID,
        viewerUserId: null,
        createAdminSupabase: () => client,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(404);
    });
  });

  describe('creating', () => {
    it('creates a comment through the counter-maintaining rpc', async () => {
      const { client, state } = createClient();

      const result = await createPostCommentForRoute({
        postId: POST_ID,
        authorUserId: AUTHOR_ID,
        readBody: async () => ({ body: '  a new comment  ' }),
        createAdminSupabase: () => client,
        checkRelationshipBlocked: async () => false,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.status).toBe(201);
      expect(result.body.commentCount).toBe(3);
      expect(result.body.comment.body).toBe('a new comment');
      expect(state.rpcCalls.find((call) => call.name === 'create_post_comment')?.args).toMatchObject({
        p_post_id: POST_ID,
        p_user_id: AUTHOR_ID,
        p_parent_comment_id: null,
        p_body: 'a new comment',
      });
    });

    it('records the comment as a feed event, attributed to the delivery the client sent', async () => {
      const { client } = createClient();
      const runAfterResponse = vi.fn();
      const scheduleFeedEvent = vi.fn(async () => undefined);

      const result = await createPostCommentForRoute({
        postId: POST_ID,
        authorUserId: AUTHOR_ID,
        readBody: async () => ({ body: 'from the feed', deliveryId: '812' }),
        createAdminSupabase: () => client,
        checkRelationshipBlocked: async () => false,
        runAfterResponse,
        scheduleFeedEvent,
      });

      expect(result).toMatchObject({ ok: true, status: 201 });
      expect(scheduleFeedEvent).toHaveBeenCalledTimes(1);
      expect(scheduleFeedEvent).toHaveBeenCalledWith(runAfterResponse, client, {
        eventType: 'comment',
        viewerUserId: AUTHOR_ID,
        postId: POST_ID,
        deliveryId: '812',
        occurredAt: '2026-07-27T12:00:00.000Z',
      });
    });

    it.each([
      ['no delivery', {}],
      ['a malformed delivery', { deliveryId: 'not-a-delivery' }],
      ['a numeric zero', { deliveryId: 0 }],
    ])('still posts the comment with %s, and records it without one', async (_label, extra) => {
      const { client } = createClient();
      const scheduleFeedEvent = vi.fn(async () => undefined);

      const result = await createPostCommentForRoute({
        postId: POST_ID,
        authorUserId: AUTHOR_ID,
        readBody: async () => ({ body: 'a comment', ...extra }),
        createAdminSupabase: () => client,
        checkRelationshipBlocked: async () => false,
        scheduleFeedEvent,
      });

      expect(result).toMatchObject({ ok: true, status: 201 });
      expect(scheduleFeedEvent).toHaveBeenCalledWith(undefined, client, expect.objectContaining({ deliveryId: null }));
    });

    it('writes no feed event for a comment that was refused', async () => {
      const scheduleFeedEvent = vi.fn(async () => undefined);
      const empty = createClient();
      await createPostCommentForRoute({
        postId: POST_ID,
        authorUserId: AUTHOR_ID,
        readBody: async () => ({ body: '  ', deliveryId: '812' }),
        createAdminSupabase: () => empty.client,
        checkRelationshipBlocked: async () => false,
        scheduleFeedEvent,
      });
      const blocked = createClient();
      await createPostCommentForRoute({
        postId: POST_ID,
        authorUserId: AUTHOR_ID,
        readBody: async () => ({ body: 'hello', deliveryId: '812' }),
        createAdminSupabase: () => blocked.client,
        checkRelationshipBlocked: async () => true,
        scheduleFeedEvent,
      });

      expect(scheduleFeedEvent).not.toHaveBeenCalled();
    });

    it('never fails the comment when its feed event cannot be written', async () => {
      // The real writer, against a client with no feed_events table at all.
      const { client } = createClient();

      const result = await createPostCommentForRoute({
        postId: POST_ID,
        authorUserId: AUTHOR_ID,
        readBody: async () => ({ body: 'still posted', deliveryId: '812' }),
        createAdminSupabase: () => client,
        checkRelationshipBlocked: async () => false,
      });

      expect(result).toMatchObject({ ok: true, status: 201, body: { commentCount: 3 } });
    });

    it('rejects an empty comment before touching the database', async () => {
      const { client, state } = createClient();

      const result = await createPostCommentForRoute({
        postId: POST_ID,
        authorUserId: AUTHOR_ID,
        readBody: async () => ({ body: '   ' }),
        createAdminSupabase: () => client,
        checkRelationshipBlocked: async () => false,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(400);
      expect(state.rpcCalls).toHaveLength(0);
    });

    it('maps malformed JSON to a stable 400 before touching the database', async () => {
      const createAdminSupabase = vi.fn();

      const result = await createPostCommentForRoute({
        postId: POST_ID,
        authorUserId: AUTHOR_ID,
        readBody: async () => {
          throw new SyntaxError('Unexpected end of JSON input');
        },
        createAdminSupabase,
        checkRelationshipBlocked: async () => false,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(400);
      expect(result.body.error).toBe('Request body must be valid JSON.');
      expect(createAdminSupabase).not.toHaveBeenCalled();
    });

    it('rejects malformed post and parent identifiers before querying uuid columns', async () => {
      const createAdminSupabase = vi.fn();

      const invalidPost = await createPostCommentForRoute({
        postId: 'not-a-uuid',
        authorUserId: AUTHOR_ID,
        readBody: async () => ({ body: 'hello' }),
        createAdminSupabase,
        checkRelationshipBlocked: async () => false,
      });
      const invalidParent = await createPostCommentForRoute({
        postId: POST_ID,
        authorUserId: AUTHOR_ID,
        readBody: async () => ({ body: 'hello', parentId: 'not-a-uuid' }),
        createAdminSupabase,
        checkRelationshipBlocked: async () => false,
      });

      expect(invalidPost).toMatchObject({ ok: false, status: 400 });
      expect(invalidParent).toMatchObject({ ok: false, status: 400 });
      expect(createAdminSupabase).not.toHaveBeenCalled();
    });

    it('refuses to comment when the viewer and post creator have blocked each other', async () => {
      const { client } = createClient();

      const result = await createPostCommentForRoute({
        postId: POST_ID,
        authorUserId: AUTHOR_ID,
        readBody: async () => ({ body: 'hello' }),
        createAdminSupabase: () => client,
        checkRelationshipBlocked: async () => true,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(403);
    });

    it('refuses to reply to a removed parent comment', async () => {
      const { client } = createClient({
        comments: [comment({ status: 'removed_by_author' })],
      });

      const result = await createPostCommentForRoute({
        postId: POST_ID,
        authorUserId: STRANGER_ID,
        readBody: async () => ({ body: 'a reply', parentId: COMMENT_ID }),
        createAdminSupabase: () => client,
        checkRelationshipBlocked: async () => false,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(404);
    });

    it('rejects replies to replies so every accepted comment is renderable', async () => {
      const { client, state } = createClient({
        comments: [comment({
          id: REPLY_ID,
          parent_comment_id: COMMENT_ID,
          user_id: STRANGER_ID,
        })],
      });

      const result = await createPostCommentForRoute({
        postId: POST_ID,
        authorUserId: AUTHOR_ID,
        readBody: async () => ({ body: 'nested reply', parentId: REPLY_ID }),
        createAdminSupabase: () => client,
        checkRelationshipBlocked: async () => false,
      });

      expect(result).toMatchObject({
        ok: false,
        status: 400,
        body: { error: 'Replies can only target top-level comments.' },
      });
      expect(state.rpcCalls.some((call) => call.name === 'create_post_comment')).toBe(false);
    });

    it('surfaces the rate limit as a 429', async () => {
      const { client } = createClient({ rateLimitAllowed: false });

      const result = await createPostCommentForRoute({
        postId: POST_ID,
        authorUserId: AUTHOR_ID,
        readBody: async () => ({ body: 'hello' }),
        createAdminSupabase: () => client,
        checkRelationshipBlocked: async () => false,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(429);
      expect(result.body.code).toBe('RATE_LIMITED');
    });
  });

  describe('removing', () => {
    it('rejects malformed identifiers before rate limiting or querying the database', async () => {
      const createAdminSupabase = vi.fn();

      const result = await removePostCommentForRoute({
        postId: POST_ID,
        commentId: 'not-a-uuid',
        actorUserId: AUTHOR_ID,
        createAdminSupabase,
      });

      expect(result).toMatchObject({ ok: false, status: 400 });
      expect(createAdminSupabase).not.toHaveBeenCalled();
    });

    it('lets the comment author soft-delete their own comment', async () => {
      const { client, state } = createClient();

      const result = await removePostCommentForRoute({
        postId: POST_ID,
        commentId: COMMENT_ID,
        actorUserId: AUTHOR_ID,
        createAdminSupabase: () => client,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.body.status).toBe('removed_by_author');
      expect(state.rpcCalls.find((call) => call.name === 'set_post_comment_status')?.args)
        .toMatchObject({ p_next_status: 'removed_by_author', p_actor_user_id: AUTHOR_ID });
    });

    it('lets the post owner remove a comment left on their post', async () => {
      const { client, state } = createClient();

      const result = await removePostCommentForRoute({
        postId: POST_ID,
        commentId: COMMENT_ID,
        actorUserId: POST_OWNER_ID,
        createAdminSupabase: () => client,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.body.status).toBe('removed_by_owner');
      expect(state.rpcCalls.find((call) => call.name === 'set_post_comment_status')?.args)
        .toMatchObject({ p_next_status: 'removed_by_owner' });
    });

    it('refuses removal by anyone else', async () => {
      const { client, state } = createClient();

      const result = await removePostCommentForRoute({
        postId: POST_ID,
        commentId: COMMENT_ID,
        actorUserId: STRANGER_ID,
        createAdminSupabase: () => client,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(403);
      expect(state.rpcCalls.some((call) => call.name === 'set_post_comment_status')).toBe(false);
    });

    it('reports 404 when the comment does not belong to the post', async () => {
      const { client } = createClient({ comments: [] });

      const result = await removePostCommentForRoute({
        postId: POST_ID,
        commentId: COMMENT_ID,
        actorUserId: AUTHOR_ID,
        createAdminSupabase: () => client,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(404);
    });
  });

  describe('updating', () => {
    const update = (
      client: SupabaseClient,
      actorUserId: string,
      body: unknown,
      commentId = COMMENT_ID,
    ) => updatePostCommentForRoute({
      postId: POST_ID,
      commentId,
      actorUserId,
      readBody: async () => body,
      createAdminSupabase: () => client,
    });

    it('takes one change a request, and names what it will take', () => {
      expect(parsePostCommentUpdate({ body: '  new words  ' })).toEqual({ kind: 'edit', body: 'new words' });
      expect(parsePostCommentUpdate({ reaction: 'like' })).toEqual({ kind: 'reaction', reaction: 'like' });
      expect(parsePostCommentUpdate({ reaction: null })).toEqual({ kind: 'reaction', reaction: null });
      expect(parsePostCommentUpdate({ hearted: true })).toEqual({ kind: 'heart', hearted: true });
      expect(parsePostCommentUpdate({ pinned: false })).toEqual({ kind: 'pin', pinned: false });

      for (const refused of [
        {}, null, [], 'like',
        { body: 'words', pinned: true },
        { reaction: 'love' }, { reaction: 'none' }, { body: '   ' }, { body: 7 },
        { hearted: 'yes' }, { pinned: 1 },
      ]) {
        expect(parsePostCommentUpdate(refused)).toHaveProperty('error');
      }
    });

    it('refuses a malformed request before the rate limit or the database', async () => {
      const { client, state, tableReads } = createClient();

      const badId = await update(client, AUTHOR_ID, { reaction: 'like' }, 'not-a-uuid');
      const badBody = await update(client, AUTHOR_ID, { reaction: 'love' });
      const badJson = await updatePostCommentForRoute({
        postId: POST_ID,
        commentId: COMMENT_ID,
        actorUserId: AUTHOR_ID,
        readBody: async () => { throw new SyntaxError('Unexpected token'); },
        createAdminSupabase: () => client,
      });

      for (const result of [badId, badBody, badJson]) {
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.status).toBe(400);
      }
      expect(state.rpcCalls).toEqual([]);
      expect(tableReads).toEqual({});
    });

    it('records a reader\'s like and answers the comment as it now is', async () => {
      const { client, state } = createClient({ comments: [comment({ like_count: 0 })] });

      const liked = await update(client, STRANGER_ID, { reaction: 'like' });

      expect(liked.ok).toBe(true);
      if (!liked.ok) return;
      expect(liked.body.comment).toMatchObject({ id: COMMENT_ID, likeCount: 1, viewerReaction: 'like' });
      expect(liked.body.unpinnedCommentId).toBeNull();
      expect(state.rpcCalls.find((call) => call.name === 'set_post_comment_reaction')?.args)
        .toEqual({ p_comment_id: COMMENT_ID, p_user_id: STRANGER_ID, p_reaction: 'like' });

      // Taken back: the function is told `none`, the answer says no reaction.
      const cleared = await update(client, STRANGER_ID, { reaction: null });
      expect(cleared.ok && cleared.body.comment).toMatchObject({ likeCount: 0, viewerReaction: null });
      expect(state.rpcCalls.at(-1)?.args).toMatchObject({ p_reaction: 'none' });
    });

    it('spends the reactions budget on a like and the mutation budget on the rest', async () => {
      const { client, state } = createClient();

      await update(client, STRANGER_ID, { reaction: 'like' });
      await update(client, AUTHOR_ID, { body: 'reworded' });

      const scopes = state.rpcCalls
        .filter((call) => call.name === 'consume_backend_rate_limit' || 'p_scope' in call.args)
        .map((call) => call.args.p_scope);
      expect(scopes).toEqual(['post-comment:react', 'post-comment:mutate']);
    });

    it('refuses a reaction across a block, with either the commenter or the post\'s creator, but lets one be taken back', async () => {
      for (const blocked of [AUTHOR_ID, POST_OWNER_ID]) {
        const { client, state } = createClient({
          userBlocks: [{ blocker_user_id: blocked, blocked_user_id: STRANGER_ID }],
          reactions: [{ comment_id: COMMENT_ID, user_id: STRANGER_ID, reaction: 'like' }],
        });

        const refused = await update(client, STRANGER_ID, { reaction: 'dislike' });
        expect(refused.ok).toBe(false);
        if (!refused.ok) expect(refused.status).toBe(403);
        expect(state.rpcCalls.some((call) => call.name === 'set_post_comment_reaction')).toBe(false);

        const takenBack = await update(client, STRANGER_ID, { reaction: null });
        expect(takenBack.ok).toBe(true);
      }
    });

    it('lets only the author edit, stamps the edit and takes the heart off', async () => {
      const { client, state } = createClient({
        comments: [comment({ hearted_at: '2026-11-02T08:00:00.000Z' })],
      });

      for (const other of [POST_OWNER_ID, STRANGER_ID]) {
        const refused = await update(client, other, { body: 'someone else\'s words' });
        expect(refused.ok).toBe(false);
        if (!refused.ok) expect(refused.status).toBe(403);
      }
      expect(state.rpcCalls.some((call) => call.name === 'edit_post_comment')).toBe(false);

      const edited = await update(client, AUTHOR_ID, { body: '  reworded  ' });
      expect(edited.ok).toBe(true);
      if (!edited.ok) return;
      expect(edited.body.comment).toMatchObject({
        body: 'reworded', editedAt: '2026-11-13T12:00:00.000Z', hearted: false,
      });
      expect(state.rpcCalls.find((call) => call.name === 'edit_post_comment')?.args)
        .toEqual({ p_comment_id: COMMENT_ID, p_actor_user_id: AUTHOR_ID, p_body: 'reworded' });
    });

    it('keeps the heart and the pin for the post\'s creator', async () => {
      const { client, state } = createClient();

      for (const change of [{ hearted: true }, { pinned: true }]) {
        for (const other of [AUTHOR_ID, STRANGER_ID]) {
          const refused = await update(client, other, change);
          expect(refused.ok).toBe(false);
          if (!refused.ok) expect(refused.status).toBe(403);
        }
      }
      expect(state.rpcCalls.some((call) => call.name.startsWith('set_post_comment_'))).toBe(false);

      const hearted = await update(client, POST_OWNER_ID, { hearted: true });
      expect(hearted.ok && hearted.body.comment.hearted).toBe(true);
      const unhearted = await update(client, POST_OWNER_ID, { hearted: false });
      expect(unhearted.ok && unhearted.body.comment.hearted).toBe(false);
    });

    it('refuses a creator\'s heart on their own comment and a pin on a reply', async () => {
      const { client, state } = createClient({
        comments: [
          comment({ user_id: POST_OWNER_ID }),
          comment({ id: REPLY_ID, parent_comment_id: COMMENT_ID }),
        ],
      });

      const ownHeart = await update(client, POST_OWNER_ID, { hearted: true });
      const replyPin = await update(client, POST_OWNER_ID, { pinned: true }, REPLY_ID);

      for (const result of [ownHeart, replyPin]) {
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.status).toBe(400);
      }
      expect(state.rpcCalls.some((call) => call.name.startsWith('set_post_comment_'))).toBe(false);
      // Unpinning is never refused for being a reply: there is nothing to refuse.
      expect((await update(client, POST_OWNER_ID, { pinned: false }, REPLY_ID)).ok).toBe(true);
    });

    it('moves the post\'s one pin and names the comment it left', async () => {
      const OTHER_ID = '50000000-0000-4000-8000-000000000009';
      const { client } = createClient({
        comments: [comment({ pinned_at: '2026-11-03T08:00:00.000Z' }), comment({ id: OTHER_ID })],
      });

      const pinned = await update(client, POST_OWNER_ID, { pinned: true }, OTHER_ID);

      expect(pinned.ok).toBe(true);
      if (!pinned.ok) return;
      expect(pinned.body.comment).toMatchObject({ id: OTHER_ID, pinned: true });
      expect(pinned.body.unpinnedCommentId).toBe(COMMENT_ID);
    });

    it('answers 404 for a removed comment, another post\'s comment and a post that takes no comments', async () => {
      const removed = createClient({ comments: [comment({ status: 'removed_by_owner' })] });
      const missing = createClient({ comments: [] });
      const privatePost = createClient({ posts: [{ ...PUBLIC_POST, visibility: 'private' }] });
      const takenDown = createClient({ posts: [{ ...PUBLIC_POST, review_status: 'removed' }] });

      for (const { client, state } of [removed, missing, privatePost, takenDown]) {
        const result = await update(client, STRANGER_ID, { reaction: 'like' });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.status).toBe(404);
        expect(state.rpcCalls.some((call) => call.name === 'set_post_comment_reaction')).toBe(false);
      }
    });

    it('surfaces the rate limit as a 429', async () => {
      const { client } = createClient({ rateLimitAllowed: false });

      const result = await update(client, STRANGER_ID, { reaction: 'like' });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.status).toBe(429);
    });
  });
});
