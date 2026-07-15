import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ProfileRow = {
  id: string;
  username: string | null;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
};

type GenerationRow = {
  id: string;
  user_id: string;
  output_url: string | null;
  showcase_asset_path: string | null;
  model: string;
  prompt: string | null;
  title: string | null;
  category: 'image' | 'video' | 'motion' | 'ugc-ad' | null;
  save_count: number | null;
  remix_count: number | null;
  created_at: string;
  is_public: boolean;
  status: string;
};

type PostRow = {
  id: string;
  output_url: string | null;
  showcase_asset_path: string | null;
  prompt: string | null;
  title: string | null;
  body: string | null;
  category: 'image' | 'video' | 'motion' | 'ugc-ad' | 'text';
  post_format: 'text' | 'media' | 'mixed';
  save_count: number | null;
  remix_count: number | null;
  created_at: string;
  generation_id: string | null;
  source_kind: 'magicbooklet' | 'emptybooklet' | 'ugc_copy' | 'external' | 'manual';
  source_tool: string | null;
  source_tool_slug?: string | null;
  review_status?: 'visible' | 'flagged' | 'hidden' | null;
  user_id: string;
  visibility: 'public' | 'unlisted' | 'private';
  archived_at?: string | null;
};

type PostMediaRow = {
  id: string;
  post_id: string;
  storage_path: string | null;
  preview_storage_path: string | null;
  preview_thumbhash: string | null;
  preview_status: 'pending' | 'processing' | 'ready' | 'failed';
  external_url: string | null;
  media_kind: 'image' | 'video';
  content_type: string | null;
  original_name: string | null;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  sort_order: number;
};

type ResourceBundleRow = {
  id: string;
  post_id: string;
  title: string;
  access_mode: 'free' | 'paid';
  price_usd_cents: number;
  preview_text: string;
  allow_remix: boolean;
  status: 'published' | 'draft';
};

let profilesState: ProfileRow[] = [];
let generationsState: GenerationRow[] = [];
let postsState: PostRow[] = [];
let postMediaState: PostMediaRow[] = [];
let resourceBundlesState: ResourceBundleRow[] = [];
let postsMissingSourceToolSlugColumn = false;
let creatorStatsRpcState: Record<string, unknown> | null = null;
let tableAccesses: string[] = [];
let bundleSummaryRpcCalls = 0;

function createResourceBundleQuery() {
  const filters: Array<(row: ResourceBundleRow) => boolean> = [];
  const query = {
    in(column: string, values: unknown[]) {
      filters.push((row) => values.includes((row as unknown as Record<string, unknown>)[column]));
      return query;
    },
    eq(column: string, value: unknown) {
      filters.push((row) => (row as unknown as Record<string, unknown>)[column] === value);
      return query;
    },
    then<TResult1 = { data: ResourceBundleRow[]; error: null }, TResult2 = never>(
      onfulfilled?: ((value: { data: ResourceBundleRow[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) {
      return Promise.resolve({
        data: resourceBundlesState.filter((row) => filters.every((filter) => filter(row))),
        error: null,
      }).then(onfulfilled, onrejected);
    },
  };

  return query;
}

function createServiceClientMock() {
  return {
    async rpc(name: string) {
      if (name === 'get_public_post_resource_bundle_summaries') {
        bundleSummaryRpcCalls += 1;
        return {
          data: resourceBundlesState.map((row) => (
            row.status === 'published'
              ? row
              : {
                  id: null,
                  post_id: row.post_id,
                  title: null,
                  access_mode: null,
                  price_usd_cents: null,
                  preview_text: null,
                  prompt_text: null,
                  notes_markdown: null,
                  workflow_share_url: null,
                  workflow_snapshot: null,
                  attachments: null,
                  allow_remix: null,
                  resource_sections: null,
                  resource_items: null,
                  sales_count: null,
                  status: row.status,
                }
          )),
          error: null,
        };
      }
      if (name !== 'get_creator_profile_stats') {
        throw new Error(`Unexpected RPC access: ${name}`);
      }
      if (creatorStatsRpcState === null) {
        return { data: null, error: { code: 'PGRST202' } };
      }
      return { data: creatorStatsRpcState, error: null };
    },
    storage: {
      from: vi.fn(() => ({
        getPublicUrl: vi.fn((path: string) => ({
          data: { publicUrl: `https://cdn.example.com/${path}` },
        })),
      })),
    },
    from(table: string) {
      tableAccesses.push(table);
      if (table === 'profiles') {
        return {
          select() {
            return {
              eq(column: string, value: unknown) {
                return {
                  async maybeSingle() {
                    const profile =
                      profilesState.find((row) => (row as Record<string, unknown>)[column] === value) ?? null;
                    return { data: profile, error: null };
                  },
                };
              },
              async in(column: string, values: unknown[]) {
                const rows = profilesState.filter((row) => values.includes((row as Record<string, unknown>)[column]));
                return { data: rows, error: null };
              },
            };
          },
        };
      }

      if (table === 'generations') {
        return {
          select() {
            const filters: Record<string, unknown> = {};
            return {
              eq(column: string, value: unknown) {
                filters[column] = value;
                return this;
              },
              neq(column: string, value: unknown) {
                filters[`neq:${column}`] = value;
                return this;
              },
              is(column: string, value: unknown) {
                filters[column] = value;
                return this;
              },
              async in(column: string, values: unknown[]) {
                const rows = generationsState.filter((row) => values.includes((row as Record<string, unknown>)[column]));
                return { data: rows, error: null };
              },
              not() {
                return this;
              },
              order() {
                return this;
              },
              async range(from: number, to: number) {
                const rows = generationsState
                  .filter((row) =>
                    Object.entries(filters).every(([key, value]) =>
                      key.startsWith('neq:')
                        ? ((row as Record<string, unknown>)[key.slice(4)] ?? null) !== value
                        : key === 'archived_at' && value === null
                        ? ((row as Record<string, unknown>)[key] ?? null) === null
                        : (row as Record<string, unknown>)[key] === value
                    )
                  )
                  .sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id))
                  .slice(from, to + 1);
                return { data: rows, error: null };
              },
              async limit(limit: number) {
                const rows = generationsState
                  .filter((row) =>
                    Object.entries(filters).every(([key, value]) =>
                      key.startsWith('neq:')
                        ? ((row as Record<string, unknown>)[key.slice(4)] ?? null) !== value
                        : key === 'archived_at' && value === null
                        ? ((row as Record<string, unknown>)[key] ?? null) === null
                        : (row as Record<string, unknown>)[key] === value
                    )
                  )
                  .slice(0, limit);
                return { data: rows, error: null };
              },
            };
          },
        };
      }

      if (table === 'posts') {
        return {
          select(fields?: string) {
            const filters: Record<string, unknown> = {};
            return {
              eq(column: string, value: unknown) {
                filters[column] = value;
                return this;
              },
              neq(column: string, value: unknown) {
                filters[`neq:${column}`] = value;
                return this;
              },
              is(column: string, value: unknown) {
                filters[column] = value;
                return this;
              },
              order() {
                return this;
              },
              async range(from: number, to: number) {
                if (postsMissingSourceToolSlugColumn && fields?.includes('source_tool_slug')) {
                  return {
                    data: null,
                    error: {
                      code: '42703',
                      message: 'column posts.source_tool_slug does not exist',
                    },
                  };
                }

                const rows = postsState
                  .filter((row) =>
                    Object.entries(filters).every(([key, value]) =>
                      key.startsWith('neq:')
                        ? ((row as Record<string, unknown>)[key.slice(4)] ?? null) !== value
                        : key === 'archived_at' && value === null
                        ? ((row as Record<string, unknown>)[key] ?? null) === null
                        : (row as Record<string, unknown>)[key] === value
                    )
                  )
                  .sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id))
                  .slice(from, to + 1);
                return { data: rows, error: null };
              },
              async limit(limit: number) {
                if (postsMissingSourceToolSlugColumn && fields?.includes('source_tool_slug')) {
                  return {
                    data: null,
                    error: {
                      code: '42703',
                      message: 'column posts.source_tool_slug does not exist',
                    },
                  };
                }

                const rows = postsState
                  .filter((row) =>
                    Object.entries(filters).every(([key, value]) =>
                      key.startsWith('neq:')
                        ? ((row as Record<string, unknown>)[key.slice(4)] ?? null) !== value
                        : key === 'archived_at' && value === null
                        ? ((row as Record<string, unknown>)[key] ?? null) === null
                        : (row as Record<string, unknown>)[key] === value
                    )
                  )
                  .slice(0, limit);
                return { data: rows, error: null };
              },
            };
          },
        };
      }

      if (table === 'post_media') {
        return {
          select() {
            return {
              in(column: string, values: unknown[]) {
                return {
                  async order() {
                    const rows = postMediaState
                      .filter((row) => values.includes((row as Record<string, unknown>)[column]))
                      .sort((left, right) => left.sort_order - right.sort_order);
                    return { data: rows, error: null };
                  },
                };
              },
            };
          },
        };
      }

      if (table === 'marketplace_assets') {
        return {
          select() {
            return {
              in() {
                return this;
              },
              async eq() {
                return {
                  data: [],
                  error: null,
                };
              },
            };
          },
        };
      }

      if (table === 'post_resource_bundles') {
        return {
          select() {
            return createResourceBundleQuery();
          },
        };
      }

      throw new Error(`Unexpected table access: ${table}`);
    },
  };
}

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => createServiceClientMock(),
  resolveStoredMediaUrl: vi.fn(async (_client, outputUrl: string) => `https://proxy.example.com/${outputUrl}`),
}));

describe('creator profile data loader', () => {
  beforeEach(() => {
    vi.resetModules();
    profilesState = [
      {
        id: 'user-1',
        username: 'creator-name',
        display_name: null,
        bio: 'Building UGC product demos.',
        avatar_url: 'https://example.com/avatar.jpg',
      },
    ];
    generationsState = [
      {
        id: 'gen-1',
        user_id: 'user-1',
        output_url: 'generated_images/user-1/file.jpg',
        showcase_asset_path: null,
        model: 'nano-banana-2',
        prompt: 'A creator unboxing a new product.',
        title: 'Unboxing Hook',
        category: 'image',
        save_count: 12,
        remix_count: 4,
        created_at: '2026-03-19T10:00:00.000Z',
        is_public: true,
        status: 'succeeded',
      },
      {
        id: 'gen-2',
        user_id: 'user-1',
        output_url: 'generated_images/user-1/private.jpg',
        showcase_asset_path: null,
        model: 'nano-banana-2',
        prompt: 'Private draft',
        title: 'Private Draft',
        category: 'image',
        save_count: 1,
        remix_count: 1,
        created_at: '2026-03-19T09:00:00.000Z',
        is_public: false,
        status: 'succeeded',
      },
    ];
    postsState = [
      {
        id: 'post-1',
        user_id: 'user-1',
        output_url: 'generated_images/user-1/file.jpg',
        showcase_asset_path: null,
        prompt: 'A creator unboxing a new product.',
        title: 'Unboxing Hook',
        body: null,
        category: 'image',
        post_format: 'media',
        save_count: 12,
        remix_count: 4,
        created_at: '2026-03-19T10:00:00.000Z',
        generation_id: 'gen-1',
        source_kind: 'magicbooklet',
        source_tool: null,
        review_status: 'visible',
        visibility: 'public',
      },
    ];
    postMediaState = [
      {
        id: 'media-1',
        post_id: 'post-1',
        storage_path: 'showcase/post-1/original.png',
        preview_storage_path: 'showcase/post-1/preview.webp',
        preview_thumbhash: 'thumbhash',
        preview_status: 'ready',
        external_url: null,
        media_kind: 'image',
        content_type: 'image/png',
        original_name: 'original.png',
        width: 1080,
        height: 1350,
        duration_seconds: null,
        sort_order: 0,
      },
    ];
    resourceBundlesState = [];
    postsMissingSourceToolSlugColumn = false;
    creatorStatsRpcState = null;
    tableAccesses = [];
    bundleSummaryRpcCalls = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns public creator data and public-only showcase items', async () => {
    const { getCreatorProfilePageData } = await import('@/lib/creator-profile');
    const data = await getCreatorProfilePageData('Creator-Name');

    expect(data).not.toBeNull();
    expect(data?.profile.displayName).toBe('creator-name');
    expect(data?.items).toHaveLength(1);
    expect(data?.items[0].creator.username).toBe('creator-name');
    expect(data?.items[0].mediaItems?.[0]).toMatchObject({
      previewUrl: 'https://cdn.example.com/showcase/post-1/preview.webp',
      previewThumbhash: 'thumbhash',
      gridReady: true,
    });
    expect(data?.stats.totalSaves).toBe(12);
    expect(data?.pageInfo.hasMore).toBe(false);
    expect(data?.pageInfo).toMatchObject({ limit: 24, offset: 0, nextOffset: null });
  });

  it('uses one bundle query and keeps draft bundle recipes private on creator pages', async () => {
    resourceBundlesState = [{
      id: 'draft-bundle-1',
      post_id: 'post-1',
      title: 'Private workflow draft',
      access_mode: 'paid',
      price_usd_cents: 1900,
      preview_text: 'This draft must not appear publicly.',
      allow_remix: true,
      status: 'draft',
    }];
    creatorStatsRpcState = {
      publicCreations: 1,
      totalSaves: 12,
      totalRemixes: 4,
      unlocks: 0,
      totalUnlockSales: 0,
      toolsUsed: [],
    };

    const { getCreatorProfilePageData } = await import('@/lib/creator-profile');
    const data = await getCreatorProfilePageData('Creator-Name');

    expect(data?.items[0].asset).toBeNull();
    expect(bundleSummaryRpcCalls).toBe(1);
    expect(tableAccesses).not.toContain('post_resource_bundles');
    expect(tableAccesses).not.toContain('generation_input_media');
  });

  it('returns stable offset pages while keeping full-profile statistics', async () => {
    postsState = Array.from({ length: 5 }, (_, index) => ({
      ...postsState[0],
      id: `post-${index + 1}`,
      generation_id: null,
      output_url: `generated_images/user-1/file-${index + 1}.jpg`,
      created_at: `2026-03-${String(20 - index).padStart(2, '0')}T10:00:00.000Z`,
      save_count: index + 1,
    }));
    postMediaState = [];

    const { getCreatorProfilePageData } = await import('@/lib/creator-profile');
    const firstPage = await getCreatorProfilePageData('Creator-Name', { limit: 2, offset: 0 });
    const secondPage = await getCreatorProfilePageData('Creator-Name', { limit: 2, offset: 2 });

    expect(firstPage?.items.map((item) => item.id)).toEqual(['post-1', 'post-2']);
    expect(secondPage?.items.map((item) => item.id)).toEqual(['post-3', 'post-4']);
    expect(firstPage?.pageInfo).toMatchObject({ hasMore: true, nextOffset: 2, limit: 2, offset: 0 });
    expect(secondPage?.pageInfo).toMatchObject({ hasMore: true, nextOffset: 4, limit: 2, offset: 2 });
    expect(firstPage?.stats).toMatchObject({ publicCreations: 5, totalSaves: 15 });
    expect(secondPage?.stats).toMatchObject({ publicCreations: 5, totalSaves: 15 });
  });

  it('hides posts that moderation has marked hidden', async () => {
    postsState[0].review_status = 'hidden';

    const { getCreatorProfilePageData } = await import('@/lib/creator-profile');
    const data = await getCreatorProfilePageData('Creator-Name');

    expect(data).not.toBeNull();
    expect(data?.items).toHaveLength(0);
  });

  it('falls back when the source tool slug column is not deployed yet', async () => {
    postsMissingSourceToolSlugColumn = true;
    postsState[0].source_tool = 'Runway';
    const { getCreatorProfilePageData } = await import('@/lib/creator-profile');
    const data = await getCreatorProfilePageData('Creator-Name');

    expect(data).not.toBeNull();
    expect(data?.items).toHaveLength(1);
    expect(data?.items[0].sourceToolSlug).toBe('runway');
  });

  it('normalizes legacy app-owned source kinds to magicbooklet', async () => {
    const { getCreatorProfilePageData } = await import('@/lib/creator-profile');

    for (const sourceKind of ['emptybooklet', 'ugc_copy'] as const) {
      postsState[0].source_kind = sourceKind;
      const data = await getCreatorProfilePageData('Creator-Name');

      expect(data).not.toBeNull();
      expect(data?.items[0].sourceKind).toBe('magicbooklet');
    }
  });

  it('returns null for unknown usernames', async () => {
    const { getCreatorProfilePageData } = await import('@/lib/creator-profile');
    const data = await getCreatorProfilePageData('missing-user');

    expect(data).toBeNull();
  });
});
