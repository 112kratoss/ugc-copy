import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { userBlockListRouteResponse } from '@/lib/moderation-route-adapter-service';
import {
  USER_BLOCK_LIST_LIMIT,
  listUserBlocksForRoute,
  type UserBlockListRouteResult,
} from '@/lib/moderation-service';

const VIEWER = '00000000-0000-4000-8000-000000000001';
const FIRST = '00000000-0000-4000-8000-00000000000a';
const SECOND = '00000000-0000-4000-8000-00000000000b';

type Call = { table: string; method: string; args: unknown[] };

/** A stand-in for the service client: answers the two tables from the rows given and keeps every call. */
function createClient(tables: {
  blocks?: Array<{ blocked_user_id: string; created_at: string }>;
  profiles?: Array<{ id: string; username: string | null; display_name: string | null; avatar_url: string | null }>;
  failing?: 'user_blocks' | 'profiles';
}) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const answer = () => Promise.resolve(tables.failing === table
        ? { data: null, error: { message: `${table} unavailable` } }
        : { data: table === 'user_blocks' ? tables.blocks ?? [] : tables.profiles ?? [], error: null });
      const record = (method: string, args: unknown[]) => {
        calls.push({ table, method, args });
      };
      const query = {
        select(...args: unknown[]) { record('select', args); return query; },
        eq(...args: unknown[]) { record('eq', args); return query; },
        order(...args: unknown[]) { record('order', args); return query; },
        limit(...args: unknown[]) { record('limit', args); return answer(); },
        in(...args: unknown[]) { record('in', args); return answer(); },
      };
      return query;
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

function createUserClient(user: { id: string; is_anonymous?: boolean } | null) {
  return {
    auth: {
      getUser: vi.fn(async () => ({ data: { user }, error: user ? null : new Error('missing session') })),
    },
  } as unknown as SupabaseClient;
}

// A block could be taken back, but only by someone who still knew the id of the
// person they had blocked: nothing listed whom the viewer had blocked, and a
// blocked creator is left out of every place that would show it.
describe('the list of whom a viewer has blocked', () => {
  it("reads the viewer's own blocks, newest first, and names each as a post's creator is named", async () => {
    const { client, calls } = createClient({
      blocks: [
        { blocked_user_id: SECOND, created_at: '2026-10-10T08:00:00.000Z' },
        { blocked_user_id: FIRST, created_at: '2026-10-01T08:00:00.000Z' },
      ],
      profiles: [
        { id: FIRST, username: 'first', display_name: '  First Creator ', avatar_url: 'https://example.com/first.jpg' },
        { id: SECOND, username: 'second', display_name: null, avatar_url: null },
      ],
    });

    await expect(listUserBlocksForRoute({ actorUserId: VIEWER, adminSupabase: client })).resolves.toEqual({
      ok: true,
      body: {
        success: true,
        blockedUsers: [
          { id: SECOND, username: 'second', name: 'second', avatar: null, blockedAt: '2026-10-10T08:00:00.000Z' },
          { id: FIRST, username: 'first', name: 'First Creator', avatar: 'https://example.com/first.jpg', blockedAt: '2026-10-01T08:00:00.000Z' },
        ],
        hasMore: false,
      },
    });
    // The viewer's own blocks and nobody else's: never the blocks made against them.
    expect(calls.filter((call) => call.table === 'user_blocks')).toEqual([
      { table: 'user_blocks', method: 'select', args: ['blocked_user_id, created_at'] },
      { table: 'user_blocks', method: 'eq', args: ['blocker_user_id', VIEWER] },
      { table: 'user_blocks', method: 'order', args: ['created_at', { ascending: false }] },
      { table: 'user_blocks', method: 'limit', args: [USER_BLOCK_LIST_LIMIT + 1] },
    ]);
    expect(calls.filter((call) => call.table === 'profiles' && call.method === 'in'))
      .toEqual([{ table: 'profiles', method: 'in', args: ['id', [SECOND, FIRST]] }]);
  });

  // A block the viewer cannot see is a block they cannot take back.
  it('lists someone who has no profile row all the same', async () => {
    const { client } = createClient({
      blocks: [{ blocked_user_id: FIRST, created_at: '2026-10-01T08:00:00.000Z' }],
      profiles: [],
    });

    const result = await listUserBlocksForRoute({ actorUserId: VIEWER, adminSupabase: client });

    expect(result.ok && result.body.blockedUsers).toEqual([
      { id: FIRST, username: null, name: expect.any(String), avatar: null, blockedAt: '2026-10-01T08:00:00.000Z' },
    ]);
    expect(result.ok && result.body.blockedUsers[0].name.length).toBeGreaterThan(0);
  });

  it('reads no profiles for an empty list', async () => {
    const { client, calls } = createClient({ blocks: [] });

    await expect(listUserBlocksForRoute({ actorUserId: VIEWER, adminSupabase: client }))
      .resolves.toEqual({ ok: true, body: { success: true, blockedUsers: [], hasMore: false } });
    expect(calls.some((call) => call.table === 'profiles')).toBe(false);
  });

  it('stops at its limit and says there are more', async () => {
    const blocks = Array.from({ length: USER_BLOCK_LIST_LIMIT + 1 }, (_, index) => ({
      blocked_user_id: `00000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`,
      created_at: '2026-10-01T08:00:00.000Z',
    }));
    const { client } = createClient({ blocks, profiles: [] });

    const result = await listUserBlocksForRoute({ actorUserId: VIEWER, adminSupabase: client });

    expect(result.ok && result.body.blockedUsers).toHaveLength(USER_BLOCK_LIST_LIMIT);
    expect(result.ok && result.body.hasMore).toBe(true);
  });

  // "There are more" is a promise the page acts on: it reads the list again after an unblock.
  it('does not say there are more when the list is exactly at its limit', async () => {
    const blocks = Array.from({ length: USER_BLOCK_LIST_LIMIT }, (_, index) => ({
      blocked_user_id: `00000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`,
      created_at: '2026-10-01T08:00:00.000Z',
    }));
    const { client } = createClient({ blocks, profiles: [] });

    const result = await listUserBlocksForRoute({ actorUserId: VIEWER, adminSupabase: client });

    expect(result.ok && result.body.blockedUsers).toHaveLength(USER_BLOCK_LIST_LIMIT);
    expect(result.ok && result.body.hasMore).toBe(false);
  });

  // An empty list would tell the viewer they have blocked nobody.
  it.each(['user_blocks', 'profiles'] as const)('fails rather than answer an empty list when %s cannot be read', async (failing) => {
    const { client } = createClient({
      blocks: [{ blocked_user_id: FIRST, created_at: '2026-10-01T08:00:00.000Z' }],
      failing,
    });

    await expect(listUserBlocksForRoute({ actorUserId: VIEWER, adminSupabase: client }))
      .resolves.toEqual({ ok: false, status: 500, body: { error: 'Failed to load blocked users.' } });
  });

  describe('over the route', () => {
    it.each([
      ['a signed-out request', null],
      ['a guest, who holds a valid token and no account', { id: 'guest-1', is_anonymous: true }],
    ])('refuses %s before anything is read', async (_label, user) => {
      const listUserBlocks = vi.fn();
      const createServiceClient = vi.fn();

      const response = await userBlockListRouteResponse({
        request: new Request('http://localhost/api/moderation/blocks'),
        dependencies: {
          createServiceClient,
          createUserClient: () => createUserClient(user),
          listUserBlocksForRoute: listUserBlocks,
        },
      });

      expect(response.status).toBe(401);
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
      expect(listUserBlocks).not.toHaveBeenCalled();
      expect(createServiceClient).not.toHaveBeenCalled();
    });

    it("answers with the signed-in viewer's list, never one a request names, and keeps it out of every cache", async () => {
      const adminSupabase = { marker: 'service' } as unknown as SupabaseClient;
      const listUserBlocks = vi.fn(async (): Promise<UserBlockListRouteResult> => ({
        ok: true,
        body: { success: true, blockedUsers: [], hasMore: false },
      }));

      const response = await userBlockListRouteResponse({
        request: new Request(`http://localhost/api/moderation/blocks?userId=${FIRST}`, {
          headers: { 'x-request-id': 'block-list-1' },
        }),
        dependencies: {
          createServiceClient: () => adminSupabase,
          createUserClient: () => createUserClient({ id: VIEWER }),
          listUserBlocksForRoute: listUserBlocks,
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
      expect(response.headers.get('x-request-id')).toBe('block-list-1');
      await expect(response.json()).resolves.toEqual({ success: true, blockedUsers: [], hasMore: false });
      expect(listUserBlocks).toHaveBeenCalledWith({ actorUserId: VIEWER, adminSupabase });
    });

    it('passes a failed reading on as a failure', async () => {
      const response = await userBlockListRouteResponse({
        request: new Request('http://localhost/api/moderation/blocks'),
        dependencies: {
          createServiceClient: () => ({}) as unknown as SupabaseClient,
          createUserClient: () => createUserClient({ id: VIEWER }),
          listUserBlocksForRoute: async () => ({ ok: false, status: 500, body: { error: 'Failed to load blocked users.' } }),
        },
      });

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: 'Failed to load blocked users.' });
    });

    it('offers the list as a read and nothing else at that address', async () => {
      const route = await import('@/app/api/moderation/blocks/route');

      expect(Object.keys(route)).toEqual(['GET']);
    });
  });
});
