import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  decodeSupportUpdatesCursor,
  encodeSupportUpdatesCursor,
  isSupportHubId,
  listSupportRoadmap,
  listSupportUpdates,
  normalizeSupportUpdatesLimit,
  setSupportUpdateReaction,
} from '@/lib/support-hub-service';

const POST_A = '7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a';
const POST_B = '6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f';
const POST_C = '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e';

type Recorded = { table?: string; calls: Array<[string, unknown[]]> };

/** A stand-in for supabase-js: records the query and answers the rows given. */
function fakeSupabase({ rows, rpcRows }: { rows: unknown[]; rpcRows: unknown[] }) {
  const recorded: Recorded = { calls: [] };
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'not', 'eq', 'is', 'or', 'order', 'limit']) {
    builder[method] = (...args: unknown[]) => {
      recorded.calls.push([method, args]);
      return builder;
    };
  }
  builder.then = (resolve: (value: unknown) => unknown) => resolve({ data: rows, error: null });
  const rpc = vi.fn(async () => ({ data: rpcRows, error: null }));
  const client = {
    from: (table: string) => {
      recorded.table = table;
      return builder;
    },
    rpc,
  } as unknown as SupabaseClient;
  return { client, recorded, rpc };
}

const row = (id: string, createdAt: string, kind = 'announcement') => ({
  id,
  support_update_kind: kind,
  title: `Title ${id.slice(0, 4)}`,
  body: 'Body',
  created_at: createdAt,
  comment_count: 2,
  comments_locked: false,
});

describe('updates cursor and limit', () => {
  it('round-trips a place and refuses anything this server did not write', () => {
    const cursor = encodeSupportUpdatesCursor({ createdAt: '2026-11-26T12:00:00.000Z', id: POST_A });
    expect(decodeSupportUpdatesCursor(cursor)).toEqual({ createdAt: '2026-11-26T12:00:00.000Z', id: POST_A });
    expect(decodeSupportUpdatesCursor('not-a-cursor')).toBeNull();
    expect(decodeSupportUpdatesCursor(Buffer.from('["yesterday","x"]').toString('base64url'))).toBeNull();
    expect(decodeSupportUpdatesCursor(null)).toBeNull();
  });

  it('takes 1 to 20 updates a page, 20 otherwise', () => {
    expect(normalizeSupportUpdatesLimit('1')).toBe(1);
    expect(normalizeSupportUpdatesLimit('20')).toBe(20);
    expect(normalizeSupportUpdatesLimit('21')).toBe(20);
    expect(normalizeSupportUpdatesLimit('0')).toBe(20);
    expect(normalizeSupportUpdatesLimit('2.5')).toBe(20);
    expect(normalizeSupportUpdatesLimit(null)).toBe(20);
  });

  it('knows an id', () => {
    expect(isSupportHubId(POST_A)).toBe(true);
    expect(isSupportHubId('post-1')).toBe(false);
  });
});

describe('listSupportUpdates', () => {
  it('lists the updates people can see, newest first, with the reader\'s reactions and a next page', async () => {
    const { client, recorded, rpc } = fakeSupabase({
      rows: [row(POST_A, '2026-11-26T12:00:00.000Z'), row(POST_B, '2026-11-25T12:00:00.000Z', 'shipped'), row(POST_C, '2026-11-24T12:00:00.000Z')],
      rpcRows: [
        { post_id: POST_A, reactions: { '👍': 3 }, my_reaction: '👍' },
        { post_id: POST_B, reactions: {}, my_reaction: null },
      ],
    });

    const page = await listSupportUpdates({ adminSupabase: client, viewerUserId: 'reader-1', cursor: null, limit: 2 });

    expect(recorded.table).toBe('posts');
    expect(recorded.calls).toEqual(expect.arrayContaining([
      ['not', ['support_update_kind', 'is', null]],
      ['eq', ['visibility', 'public']],
      ['is', ['archived_at', null]],
      ['eq', ['review_status', 'visible']],
      ['limit', [3]],
    ]));
    expect(rpc).toHaveBeenCalledWith('support_update_reactions_for', { p_post_ids: [POST_A, POST_B], p_user_id: 'reader-1' });
    expect(page.updates.map((update) => update.id)).toEqual([POST_A, POST_B]);
    expect(page.updates[0]).toMatchObject({ kind: 'announcement', reactions: { '👍': 3 }, myReaction: '👍', commentCount: 2 });
    expect(page.updates[1]?.kind).toBe('shipped');
    expect(page.latestAt).toBe('2026-11-26T12:00:00.000Z');
    expect(decodeSupportUpdatesCursor(page.nextCursor)).toEqual({ createdAt: '2026-11-25T12:00:00.000Z', id: POST_B });
  });

  it('reads a later page after its cursor, with no latestAt, and no reaction of a visitor\'s', async () => {
    const { client, recorded } = fakeSupabase({
      rows: [row(POST_C, '2026-11-24T12:00:00.000Z')],
      rpcRows: [{ post_id: POST_C, reactions: { '🙏': 1 }, my_reaction: '🙏' }],
    });
    const cursor = encodeSupportUpdatesCursor({ createdAt: '2026-11-25T12:00:00.000Z', id: POST_B });

    const page = await listSupportUpdates({ adminSupabase: client, viewerUserId: null, cursor });

    const or = recorded.calls.find(([method]) => method === 'or');
    expect(or?.[1][0]).toBe(`created_at.lt."2026-11-25T12:00:00.000Z",and(created_at.eq."2026-11-25T12:00:00.000Z",id.lt."${POST_B}")`);
    expect(page.latestAt).toBeNull();
    expect(page.nextCursor).toBeNull();
    expect(page.updates[0]?.myReaction).toBeNull();
  });
});

describe('listSupportRoadmap', () => {
  it('leaves out archived items and shipped ones past thirty days', async () => {
    const now = Date.parse('2026-11-26T00:00:00.000Z');
    const { client, recorded } = fakeSupabase({
      rows: [{ id: POST_A, title: 'Folders', summary: null, status: 'building', shipped_at: null, shipped_update_post_id: null }],
      rpcRows: [{ item_id: POST_A, reactions: { '👍': 2 }, my_reaction: null }],
    });

    const roadmap = await listSupportRoadmap({ adminSupabase: client, viewerUserId: null, now });

    expect(recorded.table).toBe('support_roadmap_items');
    expect(recorded.calls).toEqual(expect.arrayContaining([
      ['is', ['archived_at', null]],
      ['or', ['status.neq.shipped,shipped_at.gte."2026-10-27T00:00:00.000Z"']],
    ]));
    expect(roadmap.items).toEqual([{
      id: POST_A,
      title: 'Folders',
      summary: '',
      status: 'building',
      shippedAt: null,
      shippedUpdateId: null,
      reactions: { '👍': 2 },
      myReaction: null,
    }]);
  });
});

describe('setSupportUpdateReaction', () => {
  it('answers the counts, or why not', async () => {
    const reacted = { rpc: vi.fn(async () => ({ data: { status: 'reacted', myReaction: '❤️', reactions: { '❤️': 1 } }, error: null })) };
    expect(await setSupportUpdateReaction({ adminSupabase: reacted as unknown as SupabaseClient, userId: 'u', postId: POST_A, emoji: '❤️' }))
      .toEqual({ ok: true, value: { myReaction: '❤️', reactions: { '❤️': 1 } } });
    expect(reacted.rpc).toHaveBeenCalledWith('set_support_update_reaction', { p_user_id: 'u', p_post_id: POST_A, p_emoji: '❤️' });

    const gone = { rpc: vi.fn(async () => ({ data: { status: 'not_found' }, error: null })) };
    expect(await setSupportUpdateReaction({ adminSupabase: gone as unknown as SupabaseClient, userId: 'u', postId: POST_A, emoji: null }))
      .toMatchObject({ ok: false, status: 404, code: 'NOT_FOUND' });

    const failing = { rpc: vi.fn(async () => ({ data: null, error: new Error('down') })) };
    await expect(setSupportUpdateReaction({ adminSupabase: failing as unknown as SupabaseClient, userId: 'u', postId: POST_A, emoji: null }))
      .rejects.toThrow('down');
  });
});
