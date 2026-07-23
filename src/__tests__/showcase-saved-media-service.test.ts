import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { getSavedMediaFeedForRoute } from '@/lib/showcase-saved-media-service';

function createUserSupabaseMock(options?: {
  postSaves?: Array<{ post_id: string; created_at: string }>;
  legacySaves?: Array<{ generation_id: string; created_at: string }>;
  posts?: Array<Record<string, unknown>>;
  totalPostSaves?: number;
  totalLegacySaves?: number;
}) {
  const tableReads: string[] = [];

  function createSaveQuery(table: 'post_saves' | 'showcase_saves') {
    const rows = table === 'post_saves'
      ? options?.postSaves ?? []
      : options?.legacySaves ?? [];
    const totalCount = table === 'post_saves'
      ? options?.totalPostSaves ?? rows.length
      : options?.totalLegacySaves ?? rows.length;

    return {
      select(_columns: string, selectOptions?: { count?: string; head?: boolean }) {
        void _columns;
        return {
          eq(_column: string, _value: unknown) {
            void _column;
            void _value;

            if (selectOptions?.count === 'exact' && selectOptions?.head) {
              tableReads.push(`${table}:count`);
              return Promise.resolve({ data: null, count: totalCount, error: null });
            }

            return {
              order(_column: string, _options: Record<string, unknown>) {
                void _column;
                void _options;
                return {
                  range(_from: number, _to: number) {
                    void _from;
                    void _to;
                    tableReads.push(`${table}:range`);
                    return Promise.resolve({ data: rows, error: null });
                  },
                };
              },
            };
          },
        };
      },
    };
  }

  const client = {
    from(table: string) {
      if (table === 'post_saves') return createSaveQuery(table);
      if (table === 'showcase_saves') return createSaveQuery(table);
      if (table === 'posts') {
        return {
          select(_columns: string) {
            void _columns;
            return {
              in(_column: string, _values: unknown[]) {
                void _column;
                void _values;
                return {
                  in(_visibilityColumn: string, _visibilityValues: unknown[]) {
                    void _visibilityColumn;
                    void _visibilityValues;
                    tableReads.push('posts:lookup');
                    return Promise.resolve({ data: options?.posts ?? [], error: null });
                  },
                };
              },
            };
          },
        };
      }

      throw new Error(`Unexpected table access: ${table}`);
    },
  };

  return {
    client: client as unknown as SupabaseClient,
    tableReads,
  };
}

describe('getSavedMediaFeedForRoute', () => {
  it('returns an empty page without creating an admin client when there are no saved rows', async () => {
    const userSupabase = createUserSupabaseMock();
    const createAdminSupabase = vi.fn();
    const resolvePostRowsToFeedItems = vi.fn();

    const result = await getSavedMediaFeedForRoute({
      createAdminSupabase,
      limit: 24,
      offset: 0,
      resolvePostRowsToFeedItems,
      userId: 'user-1',
      userSupabase: userSupabase.client,
    });

    expect(result).toEqual({
      ok: true,
      body: {
        items: [],
        pageInfo: {
          hasMore: false,
          nextOffset: null,
          limit: 24,
          offset: 0,
        },
      },
    });
    expect(userSupabase.tableReads).toEqual(['post_saves:range', 'showcase_saves:range']);
    expect(createAdminSupabase).not.toHaveBeenCalled();
    expect(resolvePostRowsToFeedItems).not.toHaveBeenCalled();
  });

  it('hydrates saved posts in save-row order and marks them as saved', async () => {
    const userSupabase = createUserSupabaseMock({
      postSaves: [
        { post_id: 'post-2', created_at: '2026-06-10T12:00:00Z' },
        { post_id: 'post-1', created_at: '2026-06-10T10:00:00Z' },
      ],
      posts: [
        { id: 'post-1', generation_id: null, title: 'First post' },
        { id: 'post-2', generation_id: null, title: 'Second post' },
      ],
      totalPostSaves: 5,
    });
    const adminSupabase = { service: 'admin' } as unknown as SupabaseClient;
    const createAdminSupabase = vi.fn(() => adminSupabase);
    const loadBlockedCreatorIds = vi.fn(async () => new Set<string>());
    const resolvePostRowsToFeedItems = vi.fn(async (rows: Array<{ id: string; title?: string | null }>) =>
      rows.map((row) => ({
        id: row.id,
        title: row.title ?? row.id,
        generationId: null,
      }))
    );

    const result = await getSavedMediaFeedForRoute({
      createAdminSupabase,
      limit: 2,
      loadBlockedCreatorIds,
      offset: 0,
      resolvePostRowsToFeedItems,
      userId: 'user-1',
      userSupabase: userSupabase.client,
    });

    expect(result.ok).toBe(true);
    expect(result.body.items.map((item: { id: string }) => item.id)).toEqual(['post-2', 'post-1']);
    expect(result.body.items).toMatchObject([
      { id: 'post-2', isSaved: true, savedAt: '2026-06-10T12:00:00Z' },
      { id: 'post-1', isSaved: true, savedAt: '2026-06-10T10:00:00Z' },
    ]);
    expect(result.body.pageInfo).toMatchObject({
      hasMore: true,
      nextOffset: 2,
      limit: 2,
      offset: 0,
    });
    expect(createAdminSupabase).toHaveBeenCalledTimes(1);
    expect(loadBlockedCreatorIds).toHaveBeenCalledWith({
      adminSupabase,
      creatorIds: [],
      viewerUserId: 'user-1',
    });
    expect(resolvePostRowsToFeedItems).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: 'post-1' }),
        expect.objectContaining({ id: 'post-2' }),
      ]),
      adminSupabase
    );
  });

  it('removes saved posts when either user has blocked the other', async () => {
    const userSupabase = createUserSupabaseMock({
      postSaves: [
        { post_id: 'post-blocked', created_at: '2026-06-10T12:00:00Z' },
        { post_id: 'post-visible', created_at: '2026-06-10T10:00:00Z' },
      ],
      posts: [
        { id: 'post-blocked', generation_id: null, title: 'Blocked post' },
        { id: 'post-visible', generation_id: null, title: 'Visible post' },
      ],
    });
    const adminSupabase = { service: 'admin' } as unknown as SupabaseClient;
    const loadBlockedCreatorIds = vi.fn(async () => new Set(['creator-blocked']));
    const resolvePostRowsToFeedItems = vi.fn(async () => [
      { id: 'post-blocked', generationId: null, creator: { id: 'creator-blocked' } },
      { id: 'post-visible', generationId: null, creator: { id: 'creator-visible' } },
    ]);

    const result = await getSavedMediaFeedForRoute({
      createAdminSupabase: () => adminSupabase,
      limit: 24,
      loadBlockedCreatorIds,
      offset: 0,
      resolvePostRowsToFeedItems,
      userId: 'viewer-1',
      userSupabase: userSupabase.client,
    });

    expect(result.ok).toBe(true);
    expect(result.body.items.map((item: { id: string }) => item.id)).toEqual(['post-visible']);
    expect(loadBlockedCreatorIds).toHaveBeenCalledWith({
      adminSupabase,
      creatorIds: ['creator-blocked', 'creator-visible'],
      viewerUserId: 'viewer-1',
    });
  });
});
