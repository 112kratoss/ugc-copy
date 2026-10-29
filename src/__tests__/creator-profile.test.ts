import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resolveOwnedStoredMediaUrlMock = vi.hoisted(() => vi.fn());

type ProfileRow = {
  id: string;
  username: string | null;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  identity_state: 'active' | 'merged' | 'deleting';
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
  prompt_text?: string | null;
  notes_markdown?: string | null;
  attachments?: unknown;
  resource_items?: unknown;
  resource_sections?: unknown;
  sales_count?: number;
  earnings_usd_cents?: number;
};

let profilesState: ProfileRow[] = [];
let generationsState: GenerationRow[] = [];
let postsState: PostRow[] = [];
let postMediaState: PostMediaRow[] = [];
let resourceBundlesState: ResourceBundleRow[] = [];
let postsMissingSourceToolSlugColumn = false;
let postsSchemaMissing = false;
let creatorStatsRpcState: Record<string, unknown> | null = null;
let tableAccesses: string[] = [];
let bundleSummaryRpcCalls = 0;
let creatorStatsRpcCalls = 0;
// Every direct read of the recipe table: its columns and filters.
let bundleTableReads: Array<{ columns: string; filters: Record<string, unknown> }> = [];
// The generations' saved inputs, which only the read of what a recipe's
// unlock adds from them (B3) embeds.
let generationInputsState: Array<Record<string, unknown>> = [];

/**
 * A recipe as the read of what its unlock adds from the creation's saved
 * inputs nests it: its post, the post's generation and that generation's
 * inputs.
 */
function creationInputSource(bundle: ResourceBundleRow) {
  const post = postsState.find((row) => row.id === bundle.post_id) ?? null;
  const generation = post?.generation_id
    ? generationsState.find((row) => row.id === post.generation_id) ?? null
    : null;
  return {
    post_id: bundle.post_id,
    owner_user_id: post?.user_id ?? null,
    attachments: bundle.attachments ?? [],
    resource_items: bundle.resource_items ?? [],
    post: post
      ? {
          id: post.id,
          user_id: post.user_id,
          generation_id: post.generation_id,
          category: post.category,
          visibility: post.visibility,
          archived_at: post.archived_at ?? null,
          review_status: post.review_status ?? 'visible',
          source_kind: post.source_kind,
          generation: generation
            ? {
                id: generation.id,
                user_id: generation.user_id,
                is_public: generation.is_public,
                category: generation.category,
                workflow_settings: null,
                inputs: generationInputsState.filter((input) => input.generation_id === generation.id),
              }
            : null,
        }
      : null,
  };
}

function createResourceBundleQuery(columns = '') {
  const filters: Array<(row: ResourceBundleRow) => boolean> = [];
  const read = { columns, filters: {} as Record<string, unknown> };
  bundleTableReads.push(read);
  const query = {
    in(column: string, values: unknown[]) {
      read.filters[column] = values;
      filters.push((row) => values.includes((row as unknown as Record<string, unknown>)[column]));
      return query;
    },
    eq(column: string, value: unknown) {
      read.filters[column] = value;
      filters.push((row) => (row as unknown as Record<string, unknown>)[column] === value);
      return query;
    },
    abortSignal() {
      return query;
    },
    then<TResult1 = { data: unknown[]; error: null }, TResult2 = never>(
      onfulfilled?: ((value: { data: unknown[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) {
      const rows = resourceBundlesState.filter((row) => filters.every((filter) => filter(row)));
      return Promise.resolve({
        data: columns.includes('generation:generations') ? rows.map(creationInputSource) : rows,
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
      creatorStatsRpcCalls += 1;
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
              async in(column: string, values: unknown[]) {
                return { data: postsState.filter((row) => values.includes((row as unknown as Record<string, unknown>)[column])), error: null };
              },
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
                if (postsSchemaMissing) {
                  return {
                    data: null,
                    error: { code: 'PGRST205', message: "Could not find the table 'public.posts'" },
                  };
                }
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
                if (postsSchemaMissing) {
                  return {
                    data: null,
                    error: { code: 'PGRST205', message: "Could not find the table 'public.posts'" },
                  };
                }
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
          select(columns?: string) {
            return createResourceBundleQuery(columns);
          },
        };
      }

      throw new Error(`Unexpected table access: ${table}`);
    },
  };
}

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => createServiceClientMock(),
  resolveOwnedStoredMediaUrl: resolveOwnedStoredMediaUrlMock,
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
        identity_state: 'active',
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
    postsSchemaMissing = false;
    creatorStatsRpcState = null;
    tableAccesses = [];
    bundleSummaryRpcCalls = 0;
    creatorStatsRpcCalls = 0;
    bundleTableReads = [];
    generationInputsState = [];
    resolveOwnedStoredMediaUrlMock.mockReset();
    resolveOwnedStoredMediaUrlMock.mockImplementation(async (_client, outputUrl: string, ownerUserId: string) => (
      outputUrl.startsWith(`generated_images/${ownerUserId}/`)
        ? `https://proxy.example.com/${outputUrl}`
        : null
    ));
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
    // A page with no published recipe asks nothing about what an unlock adds
    // from a creation's inputs (B3).
    expect(tableAccesses).not.toContain('post_resource_bundles');
    expect(tableAccesses).not.toContain('generation_input_media');
  });

  // Recipe reading review B3: a creator page's cards tease what each recipe's
  // unlock gives, the creation's inputs its creator shares included.
  it('counts what each recipe’s unlock adds from the creation’s inputs, in one read for the page', async () => {
    resourceBundlesState = [{
      id: 'shared-bundle-1',
      post_id: 'post-1',
      title: 'Launch hook recipe',
      access_mode: 'free',
      price_usd_cents: 0,
      preview_text: 'The prompt behind it.',
      allow_remix: true,
      status: 'published',
      resource_items: [{ id: 'prompt-1', type: 'prompt', title: 'Prompt', textContent: 'The prompt behind it.' }],
    }];
    generationInputsState = ['image-1', 'image-2'].map((name, sortOrder) => ({
      id: `gen-1-${name}`,
      generation_id: 'gen-1',
      user_id: 'user-1',
      media_type: 'image',
      role: 'reference_image',
      label: `Private name of ${name}`,
      storage_path: `generation_inputs/user-1/gen-1/${name}.png`,
      source_generation_id: null,
      sort_order: sortOrder,
      metadata: {},
    }));

    const { getCreatorProfilePageData } = await import('@/lib/creator-profile');
    const data = await getCreatorProfilePageData('Creator-Name');

    expect(data?.items[0].asset?.lockedPreview?.itemCounts).toEqual({ prompt: 1, reference_image: 2 });
    expect(data?.items[0].asset?.resourceKinds).toEqual(['prompt', 'files', 'remix']);
    expect(bundleTableReads.filter((read) => read.columns.includes('generation:generations'))).toHaveLength(1);
    expect(JSON.stringify(data)).not.toContain('Private name');
  });

  it('redacts locked bundle metadata and paid recipe text on public creator pages', async () => {
    // A creator profile is as public as the showcase feed, so it owes viewers
    // the same redaction: real attachment filenames, item titles and paid
    // prompt text must never ship to a non-buyer.
    resourceBundlesState = [{
      id: 'paid-bundle-1',
      post_id: 'post-1',
      title: 'Launch hook recipe',
      access_mode: 'paid',
      price_usd_cents: 500,
      preview_text: 'Buy to unlock the full prompt.',
      allow_remix: false,
      status: 'published',
      prompt_text: 'SECRET PROMPT BODY that only buyers may read.',
      attachments: [
        { label: 'hook_prompt_v3_final.txt', kind: 'file', storagePath: 'seller-1/secret.txt' },
      ],
      resource_items: [
        {
          id: 'item-1',
          type: 'prompt',
          title: 'The exact 4-line hook that converted at 8%',
          textContent: 'SECRET PROMPT BODY that only buyers may read.',
          sortOrder: 0,
        },
      ],
      sales_count: 3,
      earnings_usd_cents: 1275,
    }];

    const { getCreatorProfilePageData } = await import('@/lib/creator-profile');
    const data = await getCreatorProfilePageData('Creator-Name');

    const asset = data?.items[0].asset;
    expect(asset).not.toBeNull();
    // Public-safe fields survive.
    expect(asset?.accessMode).toBe('paid');
    expect(asset?.priceUsdCents).toBe(500);
    expect(asset?.salesCount).toBe(3);

    // Nothing that identifies the locked payload does.
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain('SECRET PROMPT BODY');
    expect(serialized).not.toContain('hook_prompt_v3_final.txt');
    expect(serialized).not.toContain('The exact 4-line hook');
    expect(serialized).not.toContain('1275');
  });

  it('returns stable offset pages, with full-profile statistics on the first page only', async () => {
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
    // The fallback that sums every post when the RPC is missing runs for the
    // first page alone, like the RPC.
    expect(firstPage?.stats).toMatchObject({ publicCreations: 5, totalSaves: 15 });
    expect(secondPage).not.toHaveProperty('stats');
  });

  it('asks the database for the totals on the first page only', async () => {
    creatorStatsRpcState = {
      publicCreations: 40,
      totalSaves: 120,
      totalRemixes: 9,
      unlocks: 2,
      totalUnlockSales: 5,
      toolsUsed: [],
    };

    const { getCreatorProfilePageData } = await import('@/lib/creator-profile');
    const firstPage = await getCreatorProfilePageData('Creator-Name', { limit: 24, offset: 0 });
    const laterPage = await getCreatorProfilePageData('Creator-Name', { limit: 24, offset: 24 });

    expect(firstPage?.stats).toMatchObject({ publicCreations: 40, unlocks: 2 });
    expect(laterPage).not.toBeNull();
    expect(laterPage).not.toHaveProperty('stats');
    expect(creatorStatsRpcCalls).toBe(1);
  });

  it('leaves the totals off later pages of a legacy generations profile too', async () => {
    postsSchemaMissing = true;

    const { getCreatorProfilePageData } = await import('@/lib/creator-profile');
    const firstPage = await getCreatorProfilePageData('Creator-Name');
    const laterPage = await getCreatorProfilePageData('Creator-Name', { offset: 24 });

    expect(firstPage?.stats).toMatchObject({ publicCreations: 1, totalSaves: 12 });
    expect(laterPage).not.toBeNull();
    expect(laterPage).not.toHaveProperty('stats');
  });

  it('treats a creator whose account deletion has started as gone', async () => {
    profilesState[0].identity_state = 'deleting';

    const { getCreatorProfilePageData, getCreatorProfileSummary } = await import('@/lib/creator-profile');

    await expect(getCreatorProfilePageData('Creator-Name')).resolves.toBeNull();
    await expect(getCreatorProfileSummary('Creator-Name')).resolves.toBeNull();
    expect(tableAccesses).not.toContain('posts');
    expect(creatorStatsRpcCalls).toBe(0);
  });

  it('keeps showing a creator whose account is active', async () => {
    const { getCreatorProfileSummary } = await import('@/lib/creator-profile');

    await expect(getCreatorProfileSummary('Creator-Name')).resolves.toMatchObject({
      id: 'user-1',
      username: 'creator-name',
    });
  });

  it('binds legacy generation signing to the persisted generation owner', async () => {
    postsSchemaMissing = true;
    generationsState[0].output_url = 'generated_images/foreign-user/private.jpg';

    const { getCreatorProfilePageData } = await import('@/lib/creator-profile');
    const data = await getCreatorProfilePageData('Creator-Name');

    expect(data?.items).toEqual([]);
    expect(resolveOwnedStoredMediaUrlMock).toHaveBeenCalledWith(
      expect.anything(),
      'generated_images/foreign-user/private.jpg',
      'user-1',
    );
  });

  it.each(['flagged', 'hidden'] as const)('hides posts that moderation has marked %s', async (reviewStatus) => {
    postsState[0].review_status = reviewStatus;

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
