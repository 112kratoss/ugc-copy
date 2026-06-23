import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

type QueryResult<T> = {
  data: T[];
  error: null | { code?: string; message?: string };
};

const getUserMock = vi.fn<() => Promise<{
  data: { user: { id: string } | null };
  error: { name: string; message: string } | null;
}>>();

const postSavesRangeResult = vi.fn<() => Promise<QueryResult<{ post_id: string; created_at: string }>>>();
const postSavesCountResult = vi.fn<() => Promise<{ data: null; count: number | null; error: null | { code?: string; message?: string } }>>();

const legacySavesRangeResult = vi.fn<() => Promise<QueryResult<{ generation_id: string; created_at: string }>>>();
const legacySavesCountResult = vi.fn<() => Promise<{ data: null; count: number | null; error: null | { code?: string; message?: string } }>>();

const postsInResult = vi.fn<() => Promise<QueryResult<{
  id: string; title?: string | null; output_url: string | null; showcase_asset_path: string | null;
  prompt: string | null; body: string | null; category: string; post_format: string;
  save_count: number | null; remix_count: number | null; created_at: string;
  user_id: string | null; source_kind: string; source_tool: string | null;
  source_tool_slug: string | null; review_status: string | null;
  generation_id: string | null; visibility: string;
}>>>();

const fromMock = vi.fn((table: string) => {
  if (table === 'post_saves') {
    return {
      select(columns: string, options?: { count?: string; head?: boolean }) {
        // Called both for data query and count query.
        const chain: Record<string, unknown> = {
          eq: vi.fn((_column: string, _value: unknown) => {
            // Count query: .select('post_id', { count: 'exact', head: true }).eq('user_id', user.id)
            if (options?.count === 'exact' && options?.head) {
              return postSavesCountResult();
            }
            // Data query: .select('post_id, created_at').eq('user_id', user.id).order(...).range(...)
            return {
              order: vi.fn(() => ({
                range: vi.fn(() => postSavesRangeResult()),
              })),
            };
          }),
        };
        return chain;
      },
    };
  }

  if (table === 'showcase_saves') {
    return {
      select: vi.fn((_columns: string, options?: { count?: string; head?: boolean }) => ({
        eq: vi.fn(() => {
          if (options?.count === 'exact' && options?.head) {
            return legacySavesCountResult();
          }

          return {
            order: vi.fn(() => ({
              range: legacySavesRangeResult,
            })),
          };
        }),
      })),
    };
  }

  if (table === 'posts') {
    return {
      select: vi.fn(() => ({
        in: vi.fn(() => ({
          in: postsInResult,
        })),
      })),
    };
  }

  return { select: vi.fn(), eq: vi.fn(), in: vi.fn(), order: vi.fn(), range: vi.fn() };
});

vi.mock('@/lib/server-helpers', () => ({
  createUserClient: () => ({
    auth: {
      getUser: () => getUserMock(),
    },
    from: (table: string) => fromMock(table),
  }),
  createServiceClient: vi.fn(() => ({
    from: () => ({
      select: vi.fn(() => ({
        in: vi.fn(() => ({
          eq: vi.fn(() => ({
            data: [],
            error: null,
          })),
        })),
      })),
    }),
    storage: {
      from: () => ({
        getPublicUrl: vi.fn(() => ({ data: { publicUrl: '' } })),
      }),
    },
  })),
}));

vi.mock('@/lib/showcase-feed', () => ({
  resolvePostRowsToFeedItems: vi.fn(async (rows: Array<{ id: string; title?: string | null; generation_id?: string | null }>) =>
    rows.map((row) => ({
      id: row.id,
      mediaUrl: `https://cdn.example.com/${row.id}.jpg`,
      mediaKind: 'image' as const,
      model: 'test-model',
      title: row.title?.trim() || `Post ${row.id}`,
      prompt: '',
      body: '',
      category: 'image' as const,
      postFormat: 'media' as const,
      saveCount: 0,
      remixCount: 0,
      createdAt: '2026-06-10T00:00:00Z',
      creator: {
        id: 'creator-1',
        username: 'creator',
        name: 'Creator',
        avatar: null,
      },
      sourceKind: 'magicbooklet' as const,
      sourceTool: null,
      sourceToolSlug: null,
      generationId: row.generation_id ?? null,
      asset: null,
      canRemix: false,
    }))
  ),
}));

describe('/api/showcase/saved-media route', () => {
  beforeEach(() => {
    vi.resetModules();
    getUserMock.mockClear();
    postSavesRangeResult.mockReset();
    postSavesCountResult.mockReset();
    legacySavesRangeResult.mockReset();
    legacySavesCountResult.mockReset();
    postsInResult.mockReset();
    fromMock.mockClear();

    getUserMock.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns saved items ordered by post_saves.created_at desc', async () => {
    // Save rows — most recently saved first.
    postSavesRangeResult.mockResolvedValueOnce({
      data: [
        { post_id: 'post-3', created_at: '2026-06-10T12:00:00Z' },
        { post_id: 'post-1', created_at: '2026-06-10T10:00:00Z' },
        { post_id: 'post-2', created_at: '2026-06-10T08:00:00Z' },
      ],
      error: null,
    });

    // Count of total save rows.
    postSavesCountResult.mockResolvedValueOnce({
      data: null,
      count: 3,
      error: null,
    });

    // Posts query returns matching posts.
    postsInResult.mockResolvedValueOnce({
      data: [
        {
          id: 'post-1',
          title: 'First Post',
          output_url: null,
          showcase_asset_path: null,
          prompt: null,
          body: null,
          category: 'image',
          post_format: 'media',
          save_count: 5,
          remix_count: 0,
          created_at: '2026-06-09T00:00:00Z',
          user_id: 'creator-1',
          source_kind: 'magicbooklet',
          source_tool: null,
          source_tool_slug: null,
          review_status: null,
          generation_id: null,
          visibility: 'public',
        },
        {
          id: 'post-2',
          title: 'Second Post',
          output_url: null,
          showcase_asset_path: null,
          prompt: null,
          body: null,
          category: 'image',
          post_format: 'media',
          save_count: 3,
          remix_count: 0,
          created_at: '2026-06-08T00:00:00Z',
          user_id: 'creator-1',
          source_kind: 'magicbooklet',
          source_tool: null,
          source_tool_slug: null,
          review_status: null,
          generation_id: null,
          visibility: 'public',
        },
        {
          id: 'post-3',
          title: 'Third Post',
          output_url: null,
          showcase_asset_path: null,
          prompt: null,
          body: null,
          category: 'video',
          post_format: 'media',
          save_count: 1,
          remix_count: 0,
          created_at: '2026-06-07T00:00:00Z',
          user_id: 'creator-1',
          source_kind: 'magicbooklet',
          source_tool: null,
          source_tool_slug: null,
          review_status: null,
          generation_id: null,
          visibility: 'public',
        },
      ],
      error: null,
    });

    const { GET } = await import('@/app/api/showcase/saved-media/route');
    const response = await GET(
      new NextRequest('http://localhost/api/showcase/saved-media?limit=24', {
        headers: { 'x-request-id': 'saved-media-1' },
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('saved-media-1');
    const body = await response.json();

    // Items should be in save-row order: post-3 (saved most recently), post-1, post-2.
    expect(body.items.map((item: { id: string }) => item.id)).toEqual(['post-3', 'post-1', 'post-2']);

    // Each item should have isSaved: true and savedAt set.
    for (const item of body.items) {
      expect(item.isSaved).toBe(true);
      expect(typeof item.savedAt).toBe('string');
    }

    // Page info should reflect the count.
    expect(body.pageInfo).toMatchObject({
      hasMore: false,
      nextOffset: null,
      limit: 24,
      offset: 0,
    });

    // Verify savedAt values are correct.
    expect(body.items[0].savedAt).toBe('2026-06-10T12:00:00Z');
    expect(body.items[1].savedAt).toBe('2026-06-10T10:00:00Z');
    expect(body.items[2].savedAt).toBe('2026-06-10T08:00:00Z');
  });

  it('falls back to legacy showcase_saves when post_saves is not available', async () => {
    // post_saves errors with missing table.
    postSavesRangeResult.mockResolvedValueOnce({
      data: [],
      error: {
        code: 'PGRST205',
        message: "Could not find the table 'public.post_saves'",
      },
    });

    // legacy showcase_saves works.
    legacySavesRangeResult.mockResolvedValueOnce({
      data: [
        { generation_id: 'gen-2', created_at: '2026-06-10T11:00:00Z' },
        { generation_id: 'gen-1', created_at: '2026-06-10T09:00:00Z' },
      ],
      error: null,
    });

    legacySavesCountResult.mockResolvedValueOnce({
      data: null,
      count: 2,
      error: null,
    });

    // Posts are matched through posts.generation_id, not posts.id.
    postsInResult.mockResolvedValueOnce({
      data: [
        {
          id: 'post-1',
          title: 'Legacy 1',
          output_url: null,
          showcase_asset_path: null,
          prompt: null,
          body: null,
          category: 'image',
          post_format: 'media',
          save_count: 2,
          remix_count: 0,
          created_at: '2026-06-08T00:00:00Z',
          user_id: 'creator-1',
          source_kind: 'magicbooklet',
          source_tool: null,
          source_tool_slug: null,
          review_status: null,
          generation_id: 'gen-1',
          visibility: 'public',
        },
        {
          id: 'post-2',
          title: 'Legacy 2',
          output_url: null,
          showcase_asset_path: null,
          prompt: null,
          body: null,
          category: 'image',
          post_format: 'media',
          save_count: 1,
          remix_count: 0,
          created_at: '2026-06-07T00:00:00Z',
          user_id: 'creator-1',
          source_kind: 'magicbooklet',
          source_tool: null,
          source_tool_slug: null,
          review_status: null,
          generation_id: 'gen-2',
          visibility: 'public',
        },
      ],
      error: null,
    });

    const { GET } = await import('@/app/api/showcase/saved-media/route');
    const response = await GET(
      new NextRequest('http://localhost/api/showcase/saved-media?limit=24')
    );

    expect(response.status).toBe(200);
    const body = await response.json();

    // Items should be in legacy save-row order.
    expect(body.items.map((item: { id: string }) => item.id)).toEqual(['post-2', 'post-1']);
    expect(body.items[0].savedAt).toBe('2026-06-10T11:00:00Z');
    expect(body.items[1].savedAt).toBe('2026-06-10T09:00:00Z');

    expect(postSavesRangeResult).toHaveBeenCalledTimes(1);
    expect(legacySavesRangeResult).toHaveBeenCalledTimes(1);
  });

  it('uses legacy showcase saves when post_saves exists but has no rows', async () => {
    postSavesRangeResult.mockResolvedValueOnce({
      data: [],
      error: null,
    });

    legacySavesRangeResult.mockResolvedValueOnce({
      data: [
        { generation_id: 'gen-latest', created_at: '2026-06-10T14:00:00Z' },
      ],
      error: null,
    });

    legacySavesCountResult.mockResolvedValueOnce({
      data: null,
      count: 1,
      error: null,
    });

    postsInResult.mockResolvedValueOnce({
      data: [
        {
          id: 'post-latest',
          title: 'Latest legacy save',
          output_url: null,
          showcase_asset_path: null,
          prompt: null,
          body: null,
          category: 'image',
          post_format: 'media',
          save_count: 1,
          remix_count: 0,
          created_at: '2026-06-09T00:00:00Z',
          user_id: 'creator-1',
          source_kind: 'magicbooklet',
          source_tool: null,
          source_tool_slug: null,
          review_status: null,
          generation_id: 'gen-latest',
          visibility: 'public',
        },
      ],
      error: null,
    });

    const { GET } = await import('@/app/api/showcase/saved-media/route');
    const response = await GET(
      new NextRequest('http://localhost/api/showcase/saved-media?limit=24')
    );

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.items.map((item: { id: string }) => item.id)).toEqual(['post-latest']);
    expect(body.items[0].savedAt).toBe('2026-06-10T14:00:00Z');
  });

  it('skips saved posts that are private or missing', async () => {
    // Save rows reference post-1, post-2, post-3, but only post-1 and post-3 are public.
    postSavesRangeResult.mockResolvedValueOnce({
      data: [
        { post_id: 'post-1', created_at: '2026-06-10T12:00:00Z' },
        { post_id: 'post-2', created_at: '2026-06-10T10:00:00Z' },
        { post_id: 'post-3', created_at: '2026-06-10T08:00:00Z' },
      ],
      error: null,
    });

    postSavesCountResult.mockResolvedValueOnce({
      data: null,
      count: 3,
      error: null,
    });

    // Posts query only returns post-1 and post-3 (post-2 is private so not matched by visibility filter).
    postsInResult.mockResolvedValueOnce({
      data: [
        {
          id: 'post-1',
          title: 'Public Post',
          output_url: null,
          showcase_asset_path: null,
          prompt: null,
          body: null,
          category: 'image',
          post_format: 'media',
          save_count: 5,
          remix_count: 0,
          created_at: '2026-06-09T00:00:00Z',
          user_id: 'creator-1',
          source_kind: 'magicbooklet',
          source_tool: null,
          source_tool_slug: null,
          review_status: null,
          generation_id: null,
          visibility: 'public',
        },
        {
          id: 'post-3',
          title: 'Another Public Post',
          output_url: null,
          showcase_asset_path: null,
          prompt: null,
          body: null,
          category: 'video',
          post_format: 'media',
          save_count: 1,
          remix_count: 0,
          created_at: '2026-06-07T00:00:00Z',
          user_id: 'creator-1',
          source_kind: 'magicbooklet',
          source_tool: null,
          source_tool_slug: null,
          review_status: null,
          generation_id: null,
          visibility: 'public',
        },
      ],
      error: null,
    });

    const { GET } = await import('@/app/api/showcase/saved-media/route');
    const response = await GET(
      new NextRequest('http://localhost/api/showcase/saved-media?limit=24')
    );

    expect(response.status).toBe(200);
    const body = await response.json();

    // Only post-1 and post-3 should appear, in save order. post-2 is skipped.
    expect(body.items.map((item: { id: string }) => item.id)).toEqual(['post-1', 'post-3']);
    expect(body.items.length).toBe(2);
  });

  it('returns 401 when not authenticated', async () => {
    getUserMock.mockResolvedValueOnce({
      data: { user: null },
      error: { name: 'AuthError', message: 'Unauthorized' },
    });

    const { GET } = await import('@/app/api/showcase/saved-media/route');
    const response = await GET(
      new NextRequest('http://localhost/api/showcase/saved-media')
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('returns paginated results with correct hasMore', async () => {
    // 5 total saves, requesting 2 with offset 0.
    postSavesRangeResult.mockResolvedValueOnce({
      data: [
        { post_id: 'post-a', created_at: '2026-06-10T12:00:00Z' },
        { post_id: 'post-b', created_at: '2026-06-10T11:00:00Z' },
      ],
      error: null,
    });

    postSavesCountResult.mockResolvedValueOnce({
      data: null,
      count: 5,
      error: null,
    });

    postsInResult.mockResolvedValueOnce({
      data: [
        {
          id: 'post-a',
          title: 'A',
          output_url: null,
          showcase_asset_path: null,
          prompt: null,
          body: null,
          category: 'image',
          post_format: 'media',
          save_count: 1,
          remix_count: 0,
          created_at: '2026-06-09T00:00:00Z',
          user_id: 'creator-1',
          source_kind: 'magicbooklet',
          source_tool: null,
          source_tool_slug: null,
          review_status: null,
          generation_id: null,
          visibility: 'public',
        },
        {
          id: 'post-b',
          title: 'B',
          output_url: null,
          showcase_asset_path: null,
          prompt: null,
          body: null,
          category: 'image',
          post_format: 'media',
          save_count: 2,
          remix_count: 0,
          created_at: '2026-06-08T00:00:00Z',
          user_id: 'creator-1',
          source_kind: 'magicbooklet',
          source_tool: null,
          source_tool_slug: null,
          review_status: null,
          generation_id: null,
          visibility: 'public',
        },
      ],
      error: null,
    });

    const { GET } = await import('@/app/api/showcase/saved-media/route');
    const response = await GET(
      new NextRequest('http://localhost/api/showcase/saved-media?limit=2')
    );

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.items.length).toBe(2);
    expect(body.pageInfo).toMatchObject({
      hasMore: true,
      nextOffset: 2,
      limit: 2,
      offset: 0,
    });
  });
});
