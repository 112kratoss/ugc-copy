import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  AGENT_PUBLISH_RECORD_CODES,
  AGENT_TOOL_CALLS_TABLE,
  buildAgentToolCallRow,
  countAgentPublicPublishesSince,
  listAgentPublishedPosts,
  nextUtcMidnight,
  recordAgentToolCall,
  startOfUtcDay,
  uuidOrNull,
} from '@/lib/agent-tool-calls';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const GENERATION_ID = '22222222-2222-4222-8222-222222222222';
const POST_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_POST_ID = '44444444-4444-4444-8444-444444444444';

describe('the audit row', () => {
  it('takes only UUIDs for the id columns, a non-negative whole cost, and bounded text', () => {
    expect(uuidOrNull(GENERATION_ID.toUpperCase())).toBe(GENERATION_ID);
    expect(uuidOrNull(' not-a-uuid ')).toBeNull();
    expect(uuidOrNull(42)).toBeNull();
    expect(buildAgentToolCallRow({
      userId: USER_ID,
      clientId: 'client-claude',
      tool: 'create_media',
      ok: true,
      code: null,
      generationId: GENERATION_ID,
      postId: 'post-1',
      costCredits: 19,
    })).toEqual({
      user_id: USER_ID,
      client_id: 'client-claude',
      tool: 'create_media',
      ok: true,
      code: null,
      generation_id: GENERATION_ID,
      post_id: null,
      cost_credits: 19,
    });
    expect(buildAgentToolCallRow({ userId: USER_ID, clientId: 'c'.repeat(300), tool: 't'.repeat(100), ok: false, code: 'X'.repeat(100), costCredits: -1 })).toMatchObject({
      client_id: 'c'.repeat(200),
      tool: 't'.repeat(64),
      code: 'X'.repeat(64),
      cost_credits: null,
    });
    expect(buildAgentToolCallRow({ userId: USER_ID, clientId: 'c', tool: 't', ok: true, costCredits: 1.5 }).cost_credits).toBeNull();
    expect(buildAgentToolCallRow({ userId: USER_ID, clientId: 'c', tool: 't', ok: true, costCredits: 0 }).cost_credits).toBe(0);
  });

  it('writes the row to the ledger and never throws, whether the insert errors or the client does', async () => {
    const insert = vi.fn(async () => ({ error: null }));
    const admin = { from: vi.fn(() => ({ insert })) } as unknown as SupabaseClient;
    const row = buildAgentToolCallRow({ userId: USER_ID, clientId: 'client-claude', tool: 'list_models', ok: true });
    expect(await recordAgentToolCall(admin, row)).toEqual({ ok: true });
    expect(vi.mocked(admin.from)).toHaveBeenCalledWith(AGENT_TOOL_CALLS_TABLE);
    expect(insert).toHaveBeenCalledWith(row);

    const refused = { from: () => ({ insert: async () => ({ error: { message: 'permission denied' } }) }) } as unknown as SupabaseClient;
    expect(await recordAgentToolCall(refused, row)).toEqual({ ok: false, error: { message: 'permission denied' } });
    const broken = { from: () => { throw new Error('no client'); } } as unknown as SupabaseClient;
    expect(await recordAgentToolCall(broken, row)).toMatchObject({ ok: false, error: expect.any(Error) });
  });
});

describe('the daily cap\'s count', () => {
  it('counts the UTC day\'s rows recorded PUBLISHED_PUBLIC for the account, and nothing else', async () => {
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      gte: vi.fn(async () => ({ count: 7, error: null })),
    };
    const admin = { from: vi.fn(() => query) } as unknown as SupabaseClient;
    const since = new Date('2026-11-10T00:00:00.000Z');
    expect(await countAgentPublicPublishesSince(admin, { userId: USER_ID, since })).toBe(7);
    expect(vi.mocked(admin.from)).toHaveBeenCalledWith(AGENT_TOOL_CALLS_TABLE);
    expect(query.select).toHaveBeenCalledWith('id', { count: 'exact', head: true });
    expect(query.eq.mock.calls).toEqual([
      ['user_id', USER_ID],
      ['tool', 'publish_post'],
      ['ok', true],
      ['code', AGENT_PUBLISH_RECORD_CODES.PUBLISHED_PUBLIC],
    ]);
    expect(query.gte).toHaveBeenCalledWith('created_at', '2026-11-10T00:00:00.000Z');

    const empty = { select: () => empty, eq: () => empty, gte: async () => ({ count: null, error: null }) };
    expect(await countAgentPublicPublishesSince({ from: () => empty } as unknown as SupabaseClient, { userId: USER_ID, since })).toBe(0);
    const broken = { select: () => broken, eq: () => broken, gte: async () => ({ count: null, error: { message: 'down' } }) };
    await expect(countAgentPublicPublishesSince({ from: () => broken } as unknown as SupabaseClient, { userId: USER_ID, since })).rejects.toEqual({ message: 'down' });
  });

  it('measures the window as the UTC day, whatever the server\'s clock zone', () => {
    const now = Date.parse('2026-11-10T18:36:11.000Z');
    expect(startOfUtcDay(now).toISOString()).toBe('2026-11-10T00:00:00.000Z');
    expect(nextUtcMidnight(now).toISOString()).toBe('2026-11-11T00:00:00.000Z');
    expect(startOfUtcDay(Date.parse('2026-11-10T00:00:00.000Z')).toISOString()).toBe('2026-11-10T00:00:00.000Z');
    expect(nextUtcMidnight(Date.parse('2026-12-31T23:59:59.999Z')).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('the posts agents published', () => {
  /**
   * A ledger that answers the list's two reads: the publications (every row but an unchanged
   * repeat's) and the unchanged repeats, told apart by the filter on `code`. `query` is the
   * publications' read, `repeats` the other.
   */
  function admin(rows: unknown, error: unknown = null, repeatRows: unknown = []) {
    const build = () => {
      const state = { repeats: false };
      const query = {
        select: vi.fn(() => query),
        eq: vi.fn((column: string, value: unknown) => {
          if (column === 'code' && value === AGENT_PUBLISH_RECORD_CODES.ALREADY_PUBLISHED) state.repeats = true;
          return query;
        }),
        or: vi.fn(() => query),
        not: vi.fn(() => query),
        in: vi.fn(() => query),
        order: vi.fn(() => query),
        limit: vi.fn(async () => ({ data: state.repeats ? repeatRows : rows, error })),
      };
      return query;
    };
    const queries: Array<ReturnType<typeof build>> = [];
    const from = vi.fn(() => {
      const query = build();
      queries.push(query);
      return query;
    });
    return {
      client: { from } as unknown as SupabaseClient,
      from,
      get query() { return queries[0]; },
      get repeats() { return queries[1]; },
    };
  }

  it('lists each post once, newest first, dated by its first publication, from the successful publish calls', async () => {
    const ledger = admin([
      { post_id: POST_ID, user_id: USER_ID, client_id: 'client-claude', created_at: '2026-11-09T12:00:00Z', generation_id: GENERATION_ID },
      { post_id: OTHER_POST_ID, user_id: USER_ID, client_id: 'client-codex', created_at: '2026-11-09T11:00:00Z', generation_id: null },
      { post_id: POST_ID, user_id: USER_ID, client_id: 'client-claude', created_at: '2026-11-09T10:00:00Z', generation_id: GENERATION_ID },
    ]);
    const posts = await listAgentPublishedPosts(ledger.client, { limit: 10 });
    const { query } = ledger;
    // A row names the creation a post was published from, or none: a post of uploads or a text
    // post, which the row cannot tell apart (the moderation list reads the post's format).
    expect(posts).toEqual([
      { postId: POST_ID, userId: USER_ID, clientId: 'client-claude', publishedAt: '2026-11-09T10:00:00Z', generationId: GENERATION_ID },
      { postId: OTHER_POST_ID, userId: USER_ID, clientId: 'client-codex', publishedAt: '2026-11-09T11:00:00Z', generationId: null },
    ]);
    expect(query.select).toHaveBeenCalledWith('post_id, user_id, client_id, created_at, generation_id');
    expect(query.eq).toHaveBeenCalledWith('tool', 'publish_post');
    expect(query.eq).toHaveBeenCalledWith('ok', true);
    expect(query.not).toHaveBeenCalledWith('post_id', 'is', null);
    expect(query.order).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(query.limit).toHaveBeenCalledWith(40);
    expect(query.in).not.toHaveBeenCalled();
    // The publications are read apart from the unchanged repeats.
    expect(query.or).toHaveBeenCalledWith('code.is.null,code.neq.ALREADY_PUBLISHED');
  });

  // PR #751's review, finding 7: an unchanged repeat of a text or upload post names its post and
  // spends no limit. Read with the publications, a loop of them filled the page, and every other
  // agent's posts dropped out of the moderation view.
  it('keeps every publication on the list whatever number of unchanged repeats name one post', async () => {
    const publications = [
      { post_id: POST_ID, user_id: USER_ID, client_id: 'client-claude', created_at: '2026-11-10T09:00:00Z', generation_id: GENERATION_ID },
      { post_id: OTHER_POST_ID, user_id: USER_ID, client_id: 'client-codex', created_at: '2026-11-10T08:00:00Z', generation_id: null },
    ];
    const noisyPostId = '77777777-7777-4777-8777-777777777777';
    const repeatRows = Array.from({ length: 10 }, (_, index) => (
      { post_id: noisyPostId, user_id: USER_ID, client_id: 'client-loop', created_at: `2026-11-10T10:00:${String(59 - index).padStart(2, '0')}Z`, generation_id: null }
    ));
    const ledger = admin(publications, null, repeatRows);
    const posts = await listAgentPublishedPosts(ledger.client, { limit: 10 });
    // Newest first: the repeated post is on the list once, and both publications are still there.
    expect(posts.map((post) => post.postId)).toEqual([noisyPostId, POST_ID, OTHER_POST_ID]);
    expect(posts[0]).toMatchObject({ clientId: 'client-loop', publishedAt: '2026-11-10T10:00:50Z', generationId: null });
    expect(ledger.from).toHaveBeenCalledTimes(2);
    // The repeats get one page of their own, no larger than the list.
    expect(ledger.repeats.eq).toHaveBeenCalledWith('code', 'ALREADY_PUBLISHED');
    expect(ledger.repeats.limit).toHaveBeenCalledWith(10);
    expect(ledger.query.limit).toHaveBeenCalledWith(40);
  });

  it('narrows to given posts, answers no posts without a read, and throws the database\'s error', async () => {
    const narrowed = admin([{ post_id: POST_ID, user_id: USER_ID, client_id: 'c', created_at: 'now' }]);
    await listAgentPublishedPosts(narrowed.client, { limit: 5, postIds: [POST_ID, OTHER_POST_ID] });
    expect(narrowed.query.in).toHaveBeenCalledWith('post_id', [POST_ID, OTHER_POST_ID]);

    expect(narrowed.repeats.in).toHaveBeenCalledWith('post_id', [POST_ID, OTHER_POST_ID]);

    const none = admin([]);
    expect(await listAgentPublishedPosts(none.client, { limit: 5, postIds: [] })).toEqual([]);
    expect(none.from).not.toHaveBeenCalled();

    await expect(listAgentPublishedPosts(admin(null, { message: 'down' }).client, { limit: 5 })).rejects.toEqual({ message: 'down' });
  });
});
