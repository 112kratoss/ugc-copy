import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { buildPostResourceBundleLockedPreview } from '@/lib/post-resource-bundles';
import { getSavedMediaFeedForRoute } from '@/lib/showcase-saved-media-service';
import type { ShowcaseFeedItem } from '@/lib/showcase';

function createFeedItem(
  id: string,
  title: string,
  creatorId = 'creator-1'
): ShowcaseFeedItem {
  return {
    id,
    mediaUrl: null,
    mediaKind: null,
    model: 'nano-banana-2',
    title,
    prompt: '',
    body: '',
    category: 'image',
    postFormat: 'text',
    saveCount: 0,
    remixCount: 0,
    commentCount: 0,
    createdAt: '2026-06-10T09:00:00Z',
    creator: {
      id: creatorId,
      username: null,
      name: 'Creator',
      avatar: null,
    },
    sourceKind: 'magicbooklet',
    sourceTool: null,
    generationId: null,
    asset: null,
    canRemix: false,
  };
}

function createUserSupabaseMock(options?: {
  postSaves?: Array<{ post_id: string; created_at: string }>;
  legacySaves?: Array<{ generation_id: string; created_at: string }>;
  posts?: Array<Record<string, unknown>>;
  totalPostSaves?: number;
  totalLegacySaves?: number;
  userBlocks?: Array<{ blocker_user_id: string; blocked_user_id: string }>;
  userBlocksError?: { message: string };
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

            const query = {
              order() { return query; },
              or() { return query; },
              lte() { return query; },
              range() {
                tableReads.push(`${table}:range`);
                return Promise.resolve({ data: rows, error: null });
              },
            };
            return query;
          },
        };
      },
    };
  }

  const client = {
    from(table: string) {
      if (table === 'post_saves') return createSaveQuery(table);
      if (table === 'showcase_saves') return createSaveQuery(table);
      throw new Error(`Unexpected user table access: ${table}`);
    },
  };

  const adminClient = {
    from(table: string) {
      if (table === 'posts') {
        return {
          select(_columns: string) {
            void _columns;
            const query = {
              in(_column: string, _values: unknown[]) {
                void _column;
                void _values;
                return query;
              },
              eq(_column: string, _value: unknown) {
                void _column;
                void _value;
                return query;
              },
              is(_column: string, _value: unknown) {
                void _column;
                void _value;
                tableReads.push('posts:lookup');
                return Promise.resolve({ data: options?.posts ?? [], error: null });
              },
            };
            return query;
          },
        };
      }

      // The feed's viewer pass: which of the page's posts this viewer saved,
      // and the blocks between the viewer and the page's creators.
      if (table === 'post_saves') {
        return {
          select: () => ({
            eq: () => ({
              in: async () => ({ data: [], error: null }),
            }),
          }),
        };
      }

      if (table === 'post_resource_bundle_purchases') {
        return {
          select: () => ({
            eq: () => ({
              in: async () => ({ data: [], error: null }),
            }),
          }),
        };
      }

      if (table === 'user_blocks') {
        return {
          select() {
            const filters: Record<string, unknown> = {};
            const query = {
              eq(column: string, value: unknown) {
                filters[column] = value;
                return query;
              },
              async in(column: string, values: unknown[]) {
                if (options?.userBlocksError) return { data: null, error: options.userBlocksError };
                return {
                  data: (options?.userBlocks ?? []).filter((row) => (
                    Object.entries(filters).every(([key, value]) => row[key as keyof typeof row] === value)
                    && values.includes(row[column as keyof typeof row])
                  )),
                  error: null,
                };
              },
            };
            return query;
          },
        };
      }

      throw new Error(`Unexpected admin table access: ${table}`);
    },
  };

  return {
    adminClient: adminClient as unknown as SupabaseClient,
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
    const adminSupabase = userSupabase.adminClient;
    const createAdminSupabase = vi.fn(() => adminSupabase);
    const resolvePostRowsToFeedItems = vi.fn(async (rows: Array<{ id: string; title?: string | null }>) =>
      rows.map((row) => createFeedItem(row.id, row.title ?? row.id))
    );

    const result = await getSavedMediaFeedForRoute({
      createAdminSupabase,
      limit: 2,
      offset: 0,
      resolvePostRowsToFeedItems,
      userId: 'user-1',
      userSupabase: userSupabase.client,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected a saved-media page');
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
        { post_id: 'post-blocker', created_at: '2026-06-10T11:00:00Z' },
        { post_id: 'post-visible', created_at: '2026-06-10T10:00:00Z' },
      ],
      posts: [
        { id: 'post-blocked', generation_id: null, title: 'Blocked post' },
        { id: 'post-blocker', generation_id: null, title: 'Blocker post' },
        { id: 'post-visible', generation_id: null, title: 'Visible post' },
      ],
      userBlocks: [
        { blocker_user_id: 'viewer-1', blocked_user_id: 'creator-blocked' },
        { blocker_user_id: 'creator-blocker', blocked_user_id: 'viewer-1' },
      ],
    });
    const resolvePostRowsToFeedItems = vi.fn(async () => [
      createFeedItem('post-blocked', 'Blocked post', 'creator-blocked'),
      createFeedItem('post-blocker', 'Blocker post', 'creator-blocker'),
      createFeedItem('post-visible', 'Visible post', 'creator-visible'),
    ]);

    const result = await getSavedMediaFeedForRoute({
      createAdminSupabase: () => userSupabase.adminClient,
      limit: 24,
      offset: 0,
      resolvePostRowsToFeedItems,
      userId: 'viewer-1',
      userSupabase: userSupabase.client,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected a saved-media page');
    expect(result.body.items.map((item: { id: string }) => item.id)).toEqual(['post-visible']);
  });

  // Hydration already builds the public teaser (posts-server.ts). This pins
  // saved media's own pass through the sanitizer every public read ends with:
  // a raw preview, a recipe post's prompt or a field outside the asset
  // allowlist cannot reach a saver even if hydration hands one over.
  it('sends whatever hydration hands it through the public sanitizer', async () => {
    const userSupabase = createUserSupabaseMock({
      postSaves: [{ post_id: 'post-1', created_at: '2026-06-10T12:00:00Z' }],
      posts: [{ id: 'post-1', generation_id: null, title: 'First post' }],
    });
    const rawPreview = buildPostResourceBundleLockedPreview({
      attachments: [{
        label: 'lighting-diagram.pdf',
        kind: 'file',
        storagePath: 'creator-1/files/lighting-diagram.pdf',
        contentType: 'application/pdf',
        sizeBytes: 7340032,
      }],
      sections: [{ id: 'lighting', title: 'Lighting setup', kind: 'workflow_step', description: 'Two softboxes at forty-five degrees' }],
      items: [{ id: 'item-prompt', type: 'prompt', title: 'Golden hour prompt', textContent: 'SECRET_RECIPE_PROMPT', sectionId: 'lighting' }],
    } as unknown as Parameters<typeof buildPostResourceBundleLockedPreview>[0]);
    const hydrated = {
      ...createFeedItem('post-1', 'First post'),
      prompt: 'SECRET_POST_PROMPT',
      asset: {
        id: 'bundle-1',
        postId: 'post-1',
        title: 'Portrait recipe',
        accessMode: 'paid',
        priceUsdCents: 1900,
        previewText: 'Unlock the recipe.',
        allowRemix: false,
        lockedPreview: rawPreview,
        // No public read carries this; the asset allowlist drops it.
        resources: { promptText: 'SECRET_RECIPE_PROMPT' },
      },
    } as unknown as ShowcaseFeedItem;

    const result = await getSavedMediaFeedForRoute({
      createAdminSupabase: () => userSupabase.adminClient,
      limit: 24,
      offset: 0,
      resolvePostRowsToFeedItems: vi.fn(async () => [hydrated]),
      userId: 'viewer-1',
      userSupabase: userSupabase.client,
    });

    if (!result.ok) throw new Error('Expected a saved-media page');
    const [item] = result.body.items;
    expect(item.prompt).toBe('');
    expect(item.asset).not.toHaveProperty('resources');
    expect(item.asset?.lockedPreview).toMatchObject({
      sectionPreviews: [],
      attachmentPreviews: [{ label: 'File 1', contentType: null, sizeBytes: null }],
      itemPreviews: [{ type: 'prompt', title: 'Prompt', sectionId: null }],
    });
    expect(JSON.stringify(result.body)).not.toMatch(
      /SECRET|Golden hour|Lighting setup|softboxes|lighting-diagram|creator-1\/files|application\/pdf|7340032/,
    );
  });

  it('serves no saved posts when the blocks between the viewer and their creators cannot be read', async () => {
    const userSupabase = createUserSupabaseMock({
      postSaves: [{ post_id: 'post-1', created_at: '2026-06-10T12:00:00Z' }],
      posts: [{ id: 'post-1', generation_id: null, title: 'First post' }],
      userBlocksError: { message: 'user_blocks unavailable' },
    });

    const result = await getSavedMediaFeedForRoute({
      createAdminSupabase: () => userSupabase.adminClient,
      limit: 24,
      offset: 0,
      resolvePostRowsToFeedItems: vi.fn(async () => [createFeedItem('post-1', 'First post')]),
      userId: 'viewer-1',
      userSupabase: userSupabase.client,
    });

    expect(result).toMatchObject({ ok: true, body: { items: [] } });
  });
});

it('cursor pages use raw save boundaries even when all media is filtered, without counting saves', async () => {
  const rows = [1, 2, 3].map((n) => ({ post_id: `00000000-0000-0000-0000-00000000000${n}`, created_at: '2026-09-20T12:00:00.123456Z' }));
  const mock = createUserSupabaseMock({ postSaves: rows });
  const result = await getSavedMediaFeedForRoute({ createAdminSupabase: () => mock.adminClient, limit: 2, offset: 0, pagination: 'cursor', userId: 'u', userSupabase: mock.client, resolvePostRowsToFeedItems: vi.fn(async () => []) });
  expect(result).toMatchObject({ ok: true, body: { items: [], pageInfo: { hasMore: true, nextCursor: expect.any(String) } } });
  expect(mock.tableReads).not.toContain('post_saves:count');
  if (!result.ok) return;
  const empty = createUserSupabaseMock({ legacySaves: [{ generation_id: rows[0].post_id, created_at: rows[0].created_at }] });
  const end = await getSavedMediaFeedForRoute({ createAdminSupabase: vi.fn(), limit: 2, offset: 0, cursor: result.body.pageInfo.nextCursor, userId: 'u', userSupabase: empty.client });
  expect(end).toMatchObject({ ok: true, body: { items: [], pageInfo: { hasMore: false, nextCursor: null } } });
  expect(empty.tableReads).toEqual(['post_saves:range']);
});
