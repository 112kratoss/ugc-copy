import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cacheMocks = vi.hoisted(() => ({
  invalidateShowcaseFeedCache: vi.fn(),
}));

vi.mock('@/lib/showcase-feed-cache', () => cacheMocks);

import {
  archiveOwnerPostForRoute,
  restoreOwnerPostForRoute,
} from '@/lib/post-lifecycle-service';

type QueryResult = {
  data: unknown;
  error: Error | null;
};

type UpdateCall = {
  table: string;
  values: Record<string, unknown>;
  filters: Array<[string, ...unknown[]]>;
  selectColumns: string | null;
};

function createClient({
  allowed = true,
  postResult = {
    data: { id: 'post-1', generation_id: 'generation-1' },
    error: null,
  } as QueryResult,
} = {}) {
  const rpc = vi.fn(async () => ({
    data: {
      allowed,
      limit: 60,
      remaining: allowed ? 59 : 0,
      retryAfterSeconds: allowed ? 0 : 44,
      resetAt: '2026-06-22T06:30:00.000Z',
    },
    error: null,
  }));
  const updateCalls: UpdateCall[] = [];
  const from = vi.fn((table: string) => ({
    update(values: Record<string, unknown>) {
      const call: UpdateCall = {
        table,
        values,
        filters: [],
        selectColumns: null,
      };
      updateCalls.push(call);
      const result = table === 'posts'
        ? postResult
        : { data: null, error: null };
      const query = {
        eq(column: string, value: unknown) {
          call.filters.push(['eq', column, value]);
          return query;
        },
        is(column: string, value: unknown) {
          call.filters.push(['is', column, value]);
          return query;
        },
        not(column: string, operator: string, value: unknown) {
          call.filters.push(['not', column, operator, value]);
          return query;
        },
        select(columns: string) {
          call.selectColumns = columns;
          return query;
        },
        async maybeSingle() {
          return result;
        },
        then(resolve: (value: QueryResult) => unknown) {
          return Promise.resolve(result).then(resolve);
        },
      };

      return query;
    },
  }));

  return {
    client: { rpc, from } as unknown as SupabaseClient,
    from,
    rpc,
    updateCalls,
  };
}

describe('archiveOwnerPostForRoute', () => {
  beforeEach(() => {
    cacheMocks.invalidateShowcaseFeedCache.mockClear();
  });

  it('rate limits before archive mutation work', async () => {
    const client = createClient({ allowed: false });

    const result = await archiveOwnerPostForRoute({
      adminSupabase: client.client,
      now: () => new Date('2026-06-22T10:00:00.000Z'),
      ownerUserId: 'user-1',
      postId: 'post-1',
    });

    expect(result.ok).toBe(false);
    expect(result).toHaveProperty('rateLimitError');
    expect(client.from).not.toHaveBeenCalled();
    expect(cacheMocks.invalidateShowcaseFeedCache).not.toHaveBeenCalled();
  });

  it('archives owned active posts and demotes the recipe, leaving generation exposure to the posts trigger', async () => {
    const client = createClient();

    const result = await archiveOwnerPostForRoute({
      adminSupabase: client.client,
      now: () => new Date('2026-06-22T10:00:00.000Z'),
      ownerUserId: 'user-1',
      postId: 'post-1',
    });

    expect(result).toEqual({
      ok: true,
      body: { success: true, archived: true },
    });
    expect(client.updateCalls).toEqual([
      {
        table: 'posts',
        values: {
          archived_at: '2026-06-22T10:00:00.000Z',
          archived_by_user_id: 'user-1',
        },
        filters: [
          ['eq', 'id', 'post-1'],
          ['eq', 'user_id', 'user-1'],
          ['is', 'archived_at', null],
        ],
        selectColumns: 'id, generation_id',
      },
      {
        table: 'post_resource_bundles',
        values: { status: 'draft' },
        filters: [
          ['eq', 'post_id', 'post-1'],
          ['eq', 'owner_user_id', 'user-1'],
          ['eq', 'status', 'published'],
        ],
        selectColumns: null,
      },
    ]);
    expect(cacheMocks.invalidateShowcaseFeedCache).toHaveBeenCalledTimes(1);
  });

  it('returns not found without dependent mutations when no active owned post matches', async () => {
    const client = createClient({ postResult: { data: null, error: null } });

    await expect(archiveOwnerPostForRoute({
      adminSupabase: client.client,
      ownerUserId: 'user-1',
      postId: 'post-1',
    })).resolves.toEqual({
      ok: false,
      status: 404,
      body: { error: 'Post not found.' },
    });
    expect(client.updateCalls).toHaveLength(1);
  });

  it('returns a stable failure when the archive mutation fails', async () => {
    const client = createClient({
      postResult: { data: null, error: new Error('database outage') },
    });

    await expect(archiveOwnerPostForRoute({
      adminSupabase: client.client,
      ownerUserId: 'user-1',
      postId: 'post-1',
    })).resolves.toEqual({
      ok: false,
      status: 500,
      body: { error: 'Failed to archive post.' },
    });
  });
});

describe('restoreOwnerPostForRoute', () => {
  beforeEach(() => {
    cacheMocks.invalidateShowcaseFeedCache.mockClear();
  });

  it('restores only archived posts owned by the caller', async () => {
    const client = createClient({
      postResult: { data: { id: 'post-1', generation_id: null, visibility: 'public', showcase_asset_path: null }, error: null },
    });

    const result = await restoreOwnerPostForRoute({
      adminSupabase: client.client,
      ownerUserId: 'user-1',
      postId: 'post-1',
    });

    expect(result).toEqual({
      ok: true,
      body: { success: true, restored: true },
    });
    expect(client.updateCalls).toEqual([{
      table: 'posts',
      values: { archived_at: null, archived_by_user_id: null },
      filters: [
        ['eq', 'id', 'post-1'],
        ['eq', 'user_id', 'user-1'],
        ['not', 'archived_at', 'is', null],
      ],
      selectColumns: 'id, generation_id, visibility, showcase_asset_path',
    }]);
    expect(cacheMocks.invalidateShowcaseFeedCache).toHaveBeenCalledTimes(1);
  });

  // The generation's exposure used to be written here after the restore had
  // committed, and a failure was never even checked. The posts trigger now
  // recomputes it inside the restore's own statement (pgTAP:
  // generation_exposure_follows_post.test.sql), so nothing is written here.
  it.each(['public', 'private'] as const)(
    'leaves a restored %s post\'s linked generation to the posts trigger',
    async (visibility) => {
      const client = createClient({
        postResult: {
          data: {
            id: 'post-1',
            generation_id: 'generation-1',
            visibility,
            showcase_asset_path: 'showcase/generation-1/example.jpg',
          },
          error: null,
        },
      });

      await expect(restoreOwnerPostForRoute({
        adminSupabase: client.client,
        ownerUserId: 'user-1',
        postId: 'post-1',
      })).resolves.toEqual({ ok: true, body: { success: true, restored: true } });

      expect(client.updateCalls.map((call) => call.table)).toEqual(['posts']);
    },
  );

  it('returns not found when no archived owned post matches', async () => {
    const client = createClient({ postResult: { data: null, error: null } });

    await expect(restoreOwnerPostForRoute({
      adminSupabase: client.client,
      ownerUserId: 'user-1',
      postId: 'post-1',
    })).resolves.toEqual({
      ok: false,
      status: 404,
      body: { error: 'Post not found.' },
    });
  });
});
