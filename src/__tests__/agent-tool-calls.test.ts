import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  AGENT_TOOL_CALLS_TABLE,
  buildAgentToolCallRow,
  listAgentPublishedPosts,
  recordAgentToolCall,
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

describe('the posts agents published', () => {
  function admin(rows: unknown, error: unknown = null) {
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      not: vi.fn(() => query),
      in: vi.fn(() => query),
      order: vi.fn(() => query),
      limit: vi.fn(async () => ({ data: rows, error })),
    };
    return { client: { from: vi.fn(() => query) } as unknown as SupabaseClient, query };
  }

  it('lists each post once, newest first, dated by its first publication, from the successful publish calls', async () => {
    const { client, query } = admin([
      { post_id: POST_ID, user_id: USER_ID, client_id: 'client-claude', created_at: '2026-11-09T12:00:00Z' },
      { post_id: OTHER_POST_ID, user_id: USER_ID, client_id: 'client-codex', created_at: '2026-11-09T11:00:00Z' },
      { post_id: POST_ID, user_id: USER_ID, client_id: 'client-claude', created_at: '2026-11-09T10:00:00Z' },
    ]);
    const posts = await listAgentPublishedPosts(client, { limit: 10 });
    expect(posts).toEqual([
      { postId: POST_ID, userId: USER_ID, clientId: 'client-claude', publishedAt: '2026-11-09T10:00:00Z' },
      { postId: OTHER_POST_ID, userId: USER_ID, clientId: 'client-codex', publishedAt: '2026-11-09T11:00:00Z' },
    ]);
    expect(query.eq).toHaveBeenCalledWith('tool', 'publish_post');
    expect(query.eq).toHaveBeenCalledWith('ok', true);
    expect(query.not).toHaveBeenCalledWith('post_id', 'is', null);
    expect(query.order).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(query.limit).toHaveBeenCalledWith(40);
    expect(query.in).not.toHaveBeenCalled();
  });

  it('narrows to given posts, answers no posts without a read, and throws the database\'s error', async () => {
    const narrowed = admin([{ post_id: POST_ID, user_id: USER_ID, client_id: 'c', created_at: 'now' }]);
    await listAgentPublishedPosts(narrowed.client, { limit: 5, postIds: [POST_ID, OTHER_POST_ID] });
    expect(narrowed.query.in).toHaveBeenCalledWith('post_id', [POST_ID, OTHER_POST_ID]);

    const none = admin([]);
    expect(await listAgentPublishedPosts(none.client, { limit: 5, postIds: [] })).toEqual([]);
    expect(none.query.limit).not.toHaveBeenCalled();

    await expect(listAgentPublishedPosts(admin(null, { message: 'down' }).client, { limit: 5 })).rejects.toEqual({ message: 'down' });
  });
});
