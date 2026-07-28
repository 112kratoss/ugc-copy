import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  createPostCommentForRoute,
  listPostCommentsForRoute,
  normalizePostCommentBody,
  normalizePostCommentId,
  normalizePostCommentLimit,
  normalizePostCommentSort,
  removePostCommentForRoute,
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
  rateLimitAllowed = true,
} = {}) {
  const state = { comments: [...comments], rpcCalls: [] as Array<{ name: string; args: Row }> };

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

  function from(table: string) {
    const eqFilters: Record<string, unknown> = {};
    const isFilters: Record<string, unknown> = {};
    const inFilters: Record<string, unknown[]> = {};
    let orFilter: string | null = null;

    const source = (): Row[] => {
      if (table === 'posts') return posts;
      if (table === 'post_comments') return state.comments;
      if (table === 'profiles') return profiles;
      if (table === 'user_blocks') return userBlocks as unknown as Row[];
      return [];
    };

    const filteredRows = () => source().filter((row) => (
      Object.entries(eqFilters).every(([column, value]) => row[column] === value)
      && Object.entries(isFilters).every(([column, value]) => (row[column] ?? null) === value)
      && Object.entries(inFilters).every(([column, values]) => values.includes(row[column]))
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
      or(expression: string) {
        orFilter = expression;
        return query;
      },
      order: () => query,
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
        return Promise.resolve({ data: filteredRows(), error: null }).then(resolve);
      },
    };

    return query;
  }

  return { client: { from, rpc } as unknown as SupabaseClient, state };
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
});
