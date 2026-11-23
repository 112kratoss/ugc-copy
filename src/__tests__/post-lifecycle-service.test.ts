import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Which invalidation each lifecycle change makes (`showcase-feed-cache.ts`).
const cacheMocks = vi.hoisted(() => ({
  invalidateShowcaseFeedCache: vi.fn(),
  invalidateShowcaseFeedAndRefreshPostPages: vi.fn(async () => {}),
  invalidateShowcaseFeedAndRefreshEveryPage: vi.fn(),
  invalidateShowcaseFeedCacheOnly: vi.fn(),
}));

function clearCacheMocks() {
  for (const mock of Object.values(cacheMocks)) mock.mockClear();
}

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

type ReadCall = {
  table: string;
  columns: string;
  filters: Array<[string, ...unknown[]]>;
};

function createClient({
  allowed = true,
  postResult = {
    data: { id: 'post-1', generation_id: 'generation-1' },
    error: null,
  } as QueryResult,
  // What a plain read of the post finds; restore asks only after matching nothing.
  postReadResult = { data: null, error: null } as QueryResult,
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
  const readCalls: ReadCall[] = [];
  const from = vi.fn((table: string) => ({
    select(columns: string) {
      const call: ReadCall = { table, columns, filters: [] };
      readCalls.push(call);
      const query = {
        eq(column: string, value: unknown) {
          call.filters.push(['eq', column, value]);
          return query;
        },
        async maybeSingle() {
          return table === 'posts' ? postReadResult : { data: null, error: null };
        },
      };

      return query;
    },
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
    readCalls,
    rpc,
    updateCalls,
  };
}

describe('archiveOwnerPostForRoute', () => {
  beforeEach(() => {
    clearCacheMocks();
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

  it('archives owned active posts and leaves recipe and generation exposure to the posts triggers', async () => {
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
    ]);
    // A removal: the feed and every cached public page at once.
    expect(cacheMocks.invalidateShowcaseFeedCache).toHaveBeenCalledTimes(1);
    expect(cacheMocks.invalidateShowcaseFeedAndRefreshPostPages).not.toHaveBeenCalled();
    expect(cacheMocks.invalidateShowcaseFeedAndRefreshEveryPage).not.toHaveBeenCalled();
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
    clearCacheMocks();
  });

  // The public copies of a post's uploaded media (post-media-public-copies.ts).
  describe('the public copies of its uploaded media', () => {
    function copies() {
      const order: string[] = [];
      return {
        order,
        publicCopies: {
          sync: vi.fn(async () => {
            order.push('sync');
            return { begun: 1, committed: 1, refused: 0, failed: 0 };
          }),
          removeQueued: vi.fn(async () => {
            order.push('remove');
            return { due: 1, held: 0, released: 0, removed: 1, served: 0, gone: 0, rescheduled: 0, stuck: 0 };
          }),
        },
      };
    }

    it('go before the answer when the post is archived, which queued them', async () => {
      const client = createClient();
      const { publicCopies } = copies();

      const result = await archiveOwnerPostForRoute({
        adminSupabase: client.client, ownerUserId: 'user-1', postId: 'post-1', publicCopies,
      });

      expect(result).toMatchObject({ ok: true });
      expect(publicCopies.removeQueued).toHaveBeenCalledWith(client.client, { postId: 'post-1' });
      expect(publicCopies.sync).not.toHaveBeenCalled();
    });

    it('are made again for a public post restored, before its pages are refreshed', async () => {
      const client = createClient({
        postResult: { data: { id: 'post-1', generation_id: null, visibility: 'public', showcase_asset_path: null }, error: null },
      });
      const { publicCopies, order } = copies();
      cacheMocks.invalidateShowcaseFeedAndRefreshPostPages.mockImplementationOnce(async () => { order.push('refresh'); });

      await restoreOwnerPostForRoute({ adminSupabase: client.client, ownerUserId: 'user-1', postId: 'post-1', publicCopies });

      expect(publicCopies.sync).toHaveBeenCalledWith(client.client, 'post-1');
      expect(order).toEqual(['sync', 'refresh']);
    });

    it('are not made for a private post restored', async () => {
      const client = createClient({
        postResult: { data: { id: 'post-1', generation_id: null, visibility: 'private', showcase_asset_path: null }, error: null },
      });
      const { publicCopies } = copies();

      await restoreOwnerPostForRoute({ adminSupabase: client.client, ownerUserId: 'user-1', postId: 'post-1', publicCopies });

      expect(publicCopies.sync).not.toHaveBeenCalled();
    });

    it('never fail the archive when Storage refuses', async () => {
      const client = createClient();
      const { publicCopies } = copies();
      publicCopies.removeQueued.mockRejectedValueOnce(new Error('storage unavailable'));

      const result = await archiveOwnerPostForRoute({
        adminSupabase: client.client, ownerUserId: 'user-1', postId: 'post-1', publicCopies,
      });

      expect(result).toEqual({ ok: true, body: { success: true, archived: true } });
    });
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
        ['is', 'tombstoned_at', null],
      ],
      selectColumns: 'id, generation_id, visibility, showcase_asset_path',
    }]);
    expect(client.readCalls).toEqual([]);
    // Nothing is removed: the post's pages in the background, and the
    // not-found its page may hold since the archive at once.
    expect(cacheMocks.invalidateShowcaseFeedAndRefreshPostPages.mock.calls).toEqual([[client.client, {
      postId: 'post-1',
      generationId: null,
      creatorId: 'user-1',
      arrived: true,
    }]]);
    expect(cacheMocks.invalidateShowcaseFeedCache).not.toHaveBeenCalled();
  });

  it('restores a private post without calling it an arrival, and names its creation\'s address', async () => {
    const client = createClient({
      postResult: { data: { id: 'post-1', generation_id: 'gen-1', visibility: 'private', showcase_asset_path: null }, error: null },
    });

    await restoreOwnerPostForRoute({
      adminSupabase: client.client,
      ownerUserId: 'user-1',
      postId: 'post-1',
    });

    expect(cacheMocks.invalidateShowcaseFeedAndRefreshPostPages.mock.calls).toEqual([[client.client, {
      postId: 'post-1',
      generationId: 'gen-1',
      creatorId: 'user-1',
      arrived: false,
    }]]);
    expect(cacheMocks.invalidateShowcaseFeedCache).not.toHaveBeenCalled();
  });

  // 03-4: a post deleted while it had buyers is tombstoned (private and
  // archived). Restore used to clear archived_at on it like on any archive,
  // putting a deleted post back on show.
  it('refuses to restore a post its owner deleted while it had buyers', async () => {
    const client = createClient({
      postResult: { data: null, error: null },
      postReadResult: { data: { tombstoned_at: '2026-07-02T00:00:00.000Z' }, error: null },
    });

    await expect(restoreOwnerPostForRoute({
      adminSupabase: client.client,
      ownerUserId: 'user-1',
      postId: 'post-1',
    })).resolves.toEqual({
      ok: false,
      status: 409,
      body: { error: 'This post was deleted. Buyers keep their copy.', code: 'POST_DELETED' },
    });
    expect(cacheMocks.invalidateShowcaseFeedAndRefreshPostPages).not.toHaveBeenCalled();
    expect(client.updateCalls[0]?.filters).toContainEqual(['is', 'tombstoned_at', null]);
    expect(client.readCalls).toEqual([{
      table: 'posts',
      columns: 'tombstoned_at',
      filters: [
        ['eq', 'id', 'post-1'],
        ['eq', 'user_id', 'user-1'],
      ],
    }]);
    expect(cacheMocks.invalidateShowcaseFeedCache).not.toHaveBeenCalled();
  });

  it('fails stably when it cannot tell why nothing was restored', async () => {
    const client = createClient({
      postResult: { data: null, error: null },
      postReadResult: { data: null, error: new Error('database outage') },
    });

    await expect(restoreOwnerPostForRoute({
      adminSupabase: client.client,
      ownerUserId: 'user-1',
      postId: 'post-1',
    })).resolves.toEqual({
      ok: false,
      status: 500,
      body: { error: 'Failed to restore post.' },
    });
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
