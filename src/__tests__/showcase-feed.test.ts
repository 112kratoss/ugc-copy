import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ProfileRow = {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
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
  user_id: string | null;
  visibility: 'public' | 'unlisted' | 'private';
  source_kind: 'magicbooklet' | 'emptybooklet' | 'ugc_copy' | 'external' | 'manual';
  source_tool: string | null;
  source_tool_slug?: string | null;
  review_status?: string | null;
  generation_id: string | null;
  archived_at?: string | null;
};

type GenerationModelRow = {
  id: string;
  model: string;
  output_url?: string | null;
  showcase_asset_path?: string | null;
  category?: string | null;
  prompt?: string | null;
  title?: string | null;
  preview_url?: string | null;
  thumbnail_url?: string | null;
  save_count?: number | null;
  remix_count?: number | null;
  created_at?: string;
  user_id?: string | null;
  is_public?: boolean | null;
  status?: string | null;
  workflow_settings?: Record<string, unknown> | null;
};

type GenerationInputMediaRow = {
  id: string;
  generation_id: string;
  user_id: string;
  media_type: 'image' | 'video' | 'audio';
  role: string;
  label: string | null;
  storage_path: string;
  source_generation_id: string | null;
  sort_order: number | null;
  metadata: Record<string, unknown> | null;
};

type ResourceBundleRow = {
  id: string;
  post_id: string;
  title: string;
  access_mode: 'free' | 'paid';
  price_usd_cents: number;
  preview_text: string;
  prompt_text?: string | null;
  notes_markdown?: string | null;
  workflow_share_url?: string | null;
  workflow_snapshot?: unknown;
  attachments?: unknown;
  resource_sections?: unknown;
  resource_items?: unknown;
  allow_remix: boolean;
  sales_count?: number;
  status: 'published' | 'draft';
};

type PostSaveRow = {
  user_id: string;
  post_id: string;
};

type PostResourceBundlePurchaseRow = {
  bundle_id: string;
  buyer_user_id: string;
};

type PostMediaRow = {
  id: string;
  post_id: string;
  storage_path: string | null;
  external_url: string | null;
  media_kind: 'image' | 'video';
  content_type: string | null;
  original_name: string | null;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  sort_order: number;
};

let profilesState: ProfileRow[] = [];
let postsState: PostRow[] = [];
let postMediaState: PostMediaRow[] = [];
let generationModelsState: GenerationModelRow[] = [];
let generationInputMediaState: GenerationInputMediaRow[] = [];
let resourceBundlesState: ResourceBundleRow[] = [];
let postSavesState: PostSaveRow[] = [];
let postResourceBundlePurchasesState: PostResourceBundlePurchaseRow[] = [];
let postsSchemaMissingState = false;
let lastPurchaseBundleIds: unknown[] | null = null;

function createPostRow(overrides: Partial<PostRow> & { id: string; created_at: string }): PostRow {
  return {
    output_url: `generated_images/user-1/${overrides.id}.jpg`,
    showcase_asset_path: null,
    prompt: 'A creator style hero shot.',
    title: `Post ${overrides.id}`,
    body: '',
    category: 'image',
    post_format: 'media',
    save_count: 0,
    remix_count: 0,
    user_id: 'user-1',
    visibility: 'public',
    source_kind: 'external',
    source_tool: 'Runway',
    source_tool_slug: 'runway',
    generation_id: null,
    ...overrides,
  };
}

function compareValues(left: string | number | null | undefined, right: string | number | null | undefined) {
  if (left === right) {
    return 0;
  }

  if (left == null) {
    return -1;
  }

  if (right == null) {
    return 1;
  }

  return left > right ? 1 : -1;
}

function createServiceClientMock() {
  return {
    storage: {
      from: vi.fn(() => ({
        getPublicUrl: vi.fn((filePath: string) => ({
          data: { publicUrl: `https://cdn.example.com/${filePath}` },
        })),
        createSignedUrl: vi.fn(async (filePath: string) => ({
          data: { signedUrl: `https://signed.example.com/${filePath}` },
          error: null,
        })),
      })),
    },
    from(table: string) {
      if (table === 'posts') {
        const filters: Record<string, unknown> = {};
        const sorts: Array<{ column: keyof PostRow; ascending: boolean }> = [];
        let textFilter = false;
        const missingPostsError = {
          code: 'PGRST205',
          message: "Could not find the table 'public.posts'",
        };

        const query = {
          select() {
            return query;
          },
          eq(column: string, value: unknown) {
            filters[column] = value;
            return query;
          },
          is(column: string, value: unknown) {
            filters[column] = value;
            return query;
          },
          order(column: string, options: { ascending: boolean }) {
            sorts.push({ column: column as keyof PostRow, ascending: options.ascending });
            return query;
          },
          or(expression: string) {
            textFilter = expression === 'category.eq.text,post_format.eq.mixed';
            return query;
          },
          async range(start: number, end: number) {
            if (postsSchemaMissingState) {
              return { data: null, error: missingPostsError };
            }

            const rows = [...postsState]
              .filter((row) =>
                Object.entries(filters).every(([key, value]) =>
                  key === 'archived_at' && value === null
                    ? ((row as Record<string, unknown>)[key] ?? null) === null
                    : (row as Record<string, unknown>)[key] === value
                )
              )
              .filter((row) => !textFilter || row.category === 'text' || row.post_format === 'mixed')
              .sort((left, right) => {
                for (const sort of sorts) {
                  const comparison = compareValues(left[sort.column], right[sort.column]);
                  if (comparison !== 0) {
                    return sort.ascending ? comparison : -comparison;
                  }
                }

                return 0;
              })
              .slice(start, end + 1);

            return { data: rows, error: null };
          },
        };

        return query;
      }

      if (table === 'profiles') {
        return {
          select() {
            return {
              async in(_column: string, values: unknown[]) {
                return {
                  data: profilesState.filter((profile) => values.includes(profile.id)),
                  error: null,
                };
              },
            };
          },
        };
      }

      if (table === 'post_media') {
        let postIds: unknown[] = [];

        const query = {
          select() {
            return query;
          },
          in(column: string, values: unknown[]) {
            if (column === 'post_id') {
              postIds = values;
            }
            return query;
          },
          async order() {
            return {
              data: postMediaState
                .filter((row) => postIds.includes(row.post_id))
                .sort((left, right) => left.sort_order - right.sort_order),
              error: null,
            };
          },
        };

        return query;
      }

      if (table === 'generations') {
        const filters: Record<string, unknown> = {};
        const sorts: Array<{ column: keyof GenerationModelRow; ascending: boolean }> = [];

        const run = () => {
          const rows = [...generationModelsState]
            .filter((row) =>
              Object.entries(filters).every(([key, value]) => {
                const rowValue = (row as Record<string, unknown>)[key];
                return Array.isArray(value)
                  ? value.includes(rowValue)
                  : (rowValue ?? null) === value;
              })
            )
            .sort((left, right) => {
              for (const sort of sorts) {
                const comparison = compareValues(left[sort.column] as string | number | null | undefined, right[sort.column] as string | number | null | undefined);
                if (comparison !== 0) {
                  return sort.ascending ? comparison : -comparison;
                }
              }

              return 0;
            });

          return { data: rows, error: null };
        };

        const query = {
          select() {
            return query;
          },
          in(column: string, values: unknown[]) {
            filters[column] = values;
            return query;
          },
          eq(column: string, value: unknown) {
            filters[column] = value;
            return query;
          },
          is(column: string, value: unknown) {
            filters[column] = value;
            return query;
          },
          order(column: string, options: { ascending: boolean }) {
            sorts.push({ column: column as keyof GenerationModelRow, ascending: options.ascending });
            return query;
          },
          async range(start: number, end: number) {
            const rows = run().data.slice(start, end + 1);
            return { data: rows, error: null };
          },
          then(resolve: (value: { data: GenerationModelRow[]; error: null }) => void) {
            resolve(run());
          },
        };

        return query;
      }

      if (table === 'generation_input_media') {
        let generationIds: unknown[] = [];

        const query = {
          select() {
            return query;
          },
          in(column: string, values: unknown[]) {
            if (column === 'generation_id') {
              generationIds = values;
            }
            return query;
          },
          async order() {
            return {
              data: generationInputMediaState
                .filter((row) => generationIds.includes(row.generation_id))
                .sort((left, right) => (left.sort_order ?? 0) - (right.sort_order ?? 0)),
              error: null,
            };
          },
        };

        return query;
      }

      if (table === 'post_resource_bundles' || table === 'marketplace_assets') {
        let postIds: unknown[] = [];
        let status: unknown = null;

        const query = {
          select() {
            return query;
          },
          in(column: string, values: unknown[]) {
            if (column === 'post_id') {
              postIds = values;
            }
            return query;
          },
          eq(column: string, value: unknown) {
            if (column === 'status') {
              status = value;
            }
            return query;
          },
          then(resolve: (value: { data: ResourceBundleRow[]; error: null }) => void) {
            resolve({
              data: resourceBundlesState.filter(
                (row) => postIds.includes(row.post_id) && (status === null || row.status === status)
              ),
              error: null,
            });
          },
        };

        return query;
      }

      if (table === 'post_saves') {
        let userId: unknown = null;
        let postIds: unknown[] = [];

        const query = {
          select() {
            return query;
          },
          eq(column: string, value: unknown) {
            if (column === 'user_id') {
              userId = value;
            }
            return query;
          },
          async in(column: string, values: unknown[]) {
            if (column === 'post_id') {
              postIds = values;
            }

            return {
              data: postSavesState.filter(
                (row) => row.user_id === userId && postIds.includes(row.post_id)
              ),
              error: null,
            };
          },
        };

        return query;
      }

      if (table === 'post_resource_bundle_purchases') {
        let buyerUserId: unknown = null;
        let bundleIds: unknown[] = [];

        const query = {
          select() {
            return query;
          },
          eq(column: string, value: unknown) {
            if (column === 'buyer_user_id') {
              buyerUserId = value;
            }
            return query;
          },
          async in(column: string, values: unknown[]) {
            if (column === 'bundle_id') {
              bundleIds = values;
              lastPurchaseBundleIds = values;
            }

            return {
              data: postResourceBundlePurchasesState.filter(
                (row) => row.buyer_user_id === buyerUserId && bundleIds.includes(row.bundle_id)
              ),
              error: null,
            };
          },
        };

        return query;
      }

      throw new Error(`Unexpected table access: ${table}`);
    },
  };
}

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => createServiceClientMock(),
  resolveStoredMediaUrl: vi.fn(async (_client, outputUrl: string) => `https://proxy.example.com/${outputUrl}`),
}));

describe('showcase feed', () => {
  beforeEach(() => {
    vi.resetModules();
    profilesState = [
      {
        id: 'user-1',
        username: 'creator-name',
        display_name: 'Creator Name',
        avatar_url: 'https://example.com/avatar.jpg',
      },
    ];
    postsState = [
      {
        id: 'post-1',
        output_url: 'generated_images/user-1/example.jpg',
        showcase_asset_path: null,
        prompt: 'A creator style hero shot.',
        title: 'Hero Shot',
        body: '',
        category: 'image',
        post_format: 'media',
        save_count: 8,
        remix_count: 3,
        created_at: '2026-03-19T10:00:00.000Z',
        user_id: 'user-1',
        visibility: 'public',
        source_kind: 'magicbooklet',
        source_tool: null,
        generation_id: 'gen-1',
      },
    ];
    postMediaState = [];
    generationModelsState = [
      {
        id: 'gen-1',
        model: 'nano-banana-2',
      },
    ];
    generationInputMediaState = [];
    resourceBundlesState = [
      {
        id: 'asset-1',
        post_id: 'post-1',
        title: 'Hero workflow',
        access_mode: 'paid',
        price_usd_cents: 1900,
        preview_text: 'Unlock the exact prompt stack.',
        allow_remix: true,
        status: 'published',
      },
    ];
    postSavesState = [];
    postResourceBundlePurchasesState = [];
    postsSchemaMissingState = false;
    lastPurchaseBundleIds = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('includes creator usernames and asset summaries on feed items', async () => {
    const { getShowcaseFeedPage } = await import('@/lib/showcase-feed');
    const page = await getShowcaseFeedPage({
      category: 'all',
      sort: 'recent',
      offset: 0,
      limit: 12,
    });

    expect(page.items).toHaveLength(1);
    expect(page.items[0].id).toBe('post-1');
    expect(page.items[0].creator.username).toBe('creator-name');
    expect(page.items[0].creator.name).toBe('Creator Name');
    expect(page.items[0].sourceKind).toBe('magicbooklet');
    expect(page.items[0].generationId).toBe('gen-1');
    expect(page.items[0].mediaUrl).toBe('https://proxy.example.com/generated_images/user-1/example.jpg');
    expect(page.items[0].postFormat).toBe('media');
    expect(page.items[0].canRemix).toBe(false);
    expect(page.items[0].asset).toEqual({
      id: 'asset-1',
      postId: 'post-1',
      title: 'Hero workflow',
      accessMode: 'paid',
      priceUsdCents: 1900,
      priceQuote: {
        currency: 'USD',
        amountSubunits: 1900,
        formatted: '$19.00',
        note: null,
      },
      previewText: 'Unlock the exact prompt stack.',
      allowRemix: true,
      resourceKinds: ['remix'],
      itemCounts: {
        remix_access: 1,
      },
      lockedPreview: expect.objectContaining({
        resourceKinds: ['remix'],
        itemCounts: {
          remix_access: 1,
        },
        hasRemix: true,
        itemPreviews: [
          expect.objectContaining({
            type: 'remix_access',
            title: 'Remix access',
            remixUse: 'direct_remix',
          }),
        ],
      }),
    });
  });

  it('returns ordered media items while keeping the first item as the legacy cover', async () => {
    postMediaState = [
      {
        id: 'media-1',
        post_id: 'post-1',
        storage_path: 'posts/post-1/cover.png',
        external_url: null,
        media_kind: 'image',
        content_type: 'image/png',
        original_name: 'cover.png',
        width: 1080,
        height: 1350,
        duration_seconds: null,
        sort_order: 0,
      },
      {
        id: 'media-2',
        post_id: 'post-1',
        storage_path: 'posts/post-1/clip.mp4',
        external_url: null,
        media_kind: 'video',
        content_type: 'video/mp4',
        original_name: 'clip.mp4',
        width: 1080,
        height: 1920,
        duration_seconds: 8,
        sort_order: 1,
      },
    ];

    const { getShowcaseFeedPage } = await import('@/lib/showcase-feed');
    const page = await getShowcaseFeedPage({
      category: 'all',
      sort: 'recent',
      offset: 0,
      limit: 12,
    });

    expect(page.items[0].mediaUrl).toBe('https://cdn.example.com/posts/post-1/cover.png');
    expect(page.items[0].mediaKind).toBe('image');
    expect(page.items[0].mediaItems).toEqual([
      expect.objectContaining({
        id: 'media-1',
        url: 'https://cdn.example.com/posts/post-1/cover.png',
        mediaKind: 'image',
        contentType: 'image/png',
        originalName: 'cover.png',
        sortOrder: 0,
      }),
      expect.objectContaining({
        id: 'media-2',
        url: 'https://cdn.example.com/posts/post-1/clip.mp4',
        mediaKind: 'video',
        contentType: 'video/mp4',
        originalName: 'clip.mp4',
        sortOrder: 1,
      }),
    ]);
  });

  it('uses generation preview urls for generation-backed legacy post media items', async () => {
    postsState = [
      createPostRow({
        id: 'generated-video-post',
        created_at: '2026-03-20T11:00:00.000Z',
        output_url: 'generated_videos/user-1/generated-video.mp4',
        category: 'video',
        generation_id: 'gen-video',
      }),
    ];
    postMediaState = [];
    generationModelsState = [{
      id: 'gen-video',
      model: 'kling-3.0-video',
      preview_url: 'generated_videos/user-1/generated-video.preview.webp',
      category: 'video',
    }];
    resourceBundlesState = [];

    const { getShowcaseFeedPage } = await import('@/lib/showcase-feed');
    const page = await getShowcaseFeedPage({
      category: 'all',
      sort: 'recent',
      offset: 0,
      limit: 12,
    });

    expect(page.items[0].mediaItems?.[0]).toMatchObject({
      mediaKind: 'video',
      previewUrl: 'https://proxy.example.com/generated_videos/user-1/generated-video.preview.webp',
    });
  });

  it('includes mixed image and video posts in any matching media filter', async () => {
    postsState = [
      createPostRow({
        id: 'mixed-post',
        created_at: '2026-03-20T10:00:00.000Z',
        showcase_asset_path: 'posts/mixed-post/cover.png',
        output_url: null,
        category: 'image',
      }),
    ];
    postMediaState = [
      {
        id: 'media-cover',
        post_id: 'mixed-post',
        storage_path: 'posts/mixed-post/cover.png',
        external_url: null,
        media_kind: 'image',
        content_type: 'image/png',
        original_name: 'cover.png',
        width: null,
        height: null,
        duration_seconds: null,
        sort_order: 0,
      },
      {
        id: 'media-video',
        post_id: 'mixed-post',
        storage_path: 'posts/mixed-post/clip.mp4',
        external_url: null,
        media_kind: 'video',
        content_type: 'video/mp4',
        original_name: 'clip.mp4',
        width: null,
        height: null,
        duration_seconds: 6,
        sort_order: 1,
      },
    ];
    resourceBundlesState = [];

    const { getShowcaseFeedPage } = await import('@/lib/showcase-feed');
    const imagePage = await getShowcaseFeedPage({
      category: 'image',
      sort: 'recent',
      offset: 0,
      limit: 12,
    });
    const videoPage = await getShowcaseFeedPage({
      category: 'video',
      sort: 'recent',
      offset: 0,
      limit: 12,
    });

    expect(imagePage.items.map((item) => item.id)).toEqual(['mixed-post']);
    expect(videoPage.items.map((item) => item.id)).toEqual(['mixed-post']);
  });

  it('adds a safe public recipe summary for generated posts without a saved bundle', async () => {
    resourceBundlesState = [];
    generationModelsState = [{
      id: 'gen-1',
      model: 'nano-banana-2',
      category: 'image',
      prompt: 'SECRET_GENERATION_PROMPT',
      workflow_settings: {
        model: 'nano-banana-2',
        aspectRatio: '9:16',
      },
    }];
    generationInputMediaState = [{
      id: 'input-1',
      generation_id: 'gen-1',
      user_id: 'user-1',
      media_type: 'image',
      role: 'reference_image',
      label: 'Image input',
      storage_path: 'generation_inputs/user-1/gen-1/00-reference-image.png',
      source_generation_id: null,
      sort_order: 0,
      metadata: {},
    }];

    const { getShowcaseFeedPage } = await import('@/lib/showcase-feed');
    const page = await getShowcaseFeedPage({
      category: 'all',
      sort: 'recent',
      offset: 0,
      limit: 12,
    });
    const asset = page.items[0].asset;
    const serializedAsset = JSON.stringify(asset);

    expect(asset).toMatchObject({
      id: 'generation-recipe:post-1',
      postId: 'post-1',
      title: 'Creation recipe',
      accessMode: 'free',
      priceUsdCents: 0,
      resourceKinds: ['prompt', 'files', 'notes'],
      itemCounts: {
        prompt: 1,
        reference_image: 1,
        note: 1,
      },
    });
    expect(serializedAsset).not.toContain('SECRET_GENERATION_PROMPT');
    expect(serializedAsset).not.toContain('generation_inputs/user-1');
  });

  it('adds safe public recipe reference counts from legacy workflow settings', async () => {
    resourceBundlesState = [];
    generationModelsState = [{
      id: 'gen-1',
      model: 'nano-banana-2',
      category: 'image',
      prompt: 'SECRET_LEGACY_PROMPT',
      workflow_settings: {
        model: 'nano-banana-2',
        aspectRatio: '9:16',
        elements: [{
          id: 'element-1',
          displayName: 'Image input',
          handle: '@alisa',
          storagePath: 'generation_inputs/user-1/gen-1/legacy-reference.png',
        }],
      },
    }];
    generationInputMediaState = [];

    const { getShowcaseFeedPage } = await import('@/lib/showcase-feed');
    const page = await getShowcaseFeedPage({
      category: 'all',
      sort: 'recent',
      offset: 0,
      limit: 12,
    });
    const asset = page.items[0].asset;
    const serializedAsset = JSON.stringify(asset);

    expect(asset).toMatchObject({
      id: 'generation-recipe:post-1',
      accessMode: 'free',
      resourceKinds: ['prompt', 'files', 'notes', 'remix'],
      itemCounts: {
        prompt: 1,
        reference_image: 1,
        note: 1,
      },
    });
    expect(serializedAsset).not.toContain('SECRET_LEGACY_PROMPT');
    expect(serializedAsset).not.toContain('generation_inputs/user-1');
  });

  it('does not expose raw paid unlock resources on public feed asset summaries', async () => {
    resourceBundlesState[0] = {
      ...resourceBundlesState[0],
      prompt_text: 'SECRET_FEED_PROMPT',
      notes_markdown: 'SECRET_FEED_NOTES',
      workflow_share_url: 'https://secret.example/workflow',
      workflow_snapshot: { nodes: [{ id: 'secret-node' }] },
      attachments: [
        {
          label: 'Secret source file',
          kind: 'file',
          storagePath: 'user-1/private/source.png',
          contentType: 'image/png',
          sizeBytes: 2048,
        },
      ],
      resource_sections: [
        {
          id: 'setup',
          title: 'Setup',
          kind: 'workflow_step',
          description: 'Safe section description.',
        },
      ],
      resource_items: [
        {
          type: 'prompt',
          title: 'Prompt',
          textContent: 'SECRET_TYPED_PROMPT',
          sectionId: 'setup',
        },
        {
          type: 'workflow',
          title: 'Workflow',
          externalUrl: 'https://secret.example/typed-workflow',
          workflowSnapshot: { nodes: [{ id: 'typed-secret-node' }] },
          remixUse: 'import_source',
        },
        {
          type: 'reference_image',
          title: 'Reference image',
          storagePath: 'user-1/private/reference.png',
          contentType: 'image/png',
          remixUse: 'reference_only',
        },
        {
          type: 'note',
          title: 'Notes',
          textContent: 'SECRET_TYPED_NOTES',
        },
      ],
      allow_remix: false,
    };

    const { getShowcaseFeedPage } = await import('@/lib/showcase-feed');
    const page = await getShowcaseFeedPage({
      category: 'all',
      sort: 'recent',
      offset: 0,
      limit: 12,
    });
    const asset = page.items[0].asset as unknown as Record<string, unknown>;
    const serializedAsset = JSON.stringify(asset);

    expect(asset).not.toHaveProperty('resourceItems');
    expect(asset).not.toHaveProperty('resourceSections');
    expect(asset.lockedPreview).toEqual(expect.objectContaining({
      hasPrompt: true,
      hasNotes: true,
      hasWorkflow: true,
      hasRemix: false,
      resourceKinds: ['prompt', 'workflow', 'files', 'notes'],
      itemCounts: {
        prompt: 1,
        workflow: 1,
        reference_image: 1,
        note: 1,
      },
    }));
    expect(serializedAsset).not.toContain('SECRET_FEED_PROMPT');
    expect(serializedAsset).not.toContain('SECRET_FEED_NOTES');
    expect(serializedAsset).not.toContain('SECRET_TYPED_PROMPT');
    expect(serializedAsset).not.toContain('SECRET_TYPED_NOTES');
    expect(serializedAsset).not.toContain('https://secret.example');
    expect(serializedAsset).not.toContain('user-1/private');
    expect(serializedAsset).not.toContain('secret-node');
    expect(serializedAsset).not.toContain('typed-secret-node');
  });

  it('normalizes legacy app-created source rows to magicbooklet', async () => {
    const { getShowcaseFeedPage } = await import('@/lib/showcase-feed');

    for (const sourceKind of ['emptybooklet', 'ugc_copy'] as const) {
      postsState[0].source_kind = sourceKind;

      const page = await getShowcaseFeedPage({
        category: 'all',
        sort: 'recent',
        offset: 0,
        limit: 12,
      });

      expect(page.items[0].sourceKind).toBe('magicbooklet');
    }
  });

  it('restores remix access for the bundle owner in personalized feed results', async () => {
    const { getShowcaseFeedPage } = await import('@/lib/showcase-feed');
    const page = await getShowcaseFeedPage({
      category: 'all',
      sort: 'recent',
      offset: 0,
      limit: 12,
      viewerUserId: 'user-1',
    });

    expect(page.items).toHaveLength(1);
    expect(page.items[0].canRemix).toBe(true);
  });

  it('restores remix access for purchasers of remix-enabled bundles', async () => {
    postResourceBundlePurchasesState = [
      {
        bundle_id: 'asset-1',
        buyer_user_id: 'buyer-1',
      },
    ];

    const { getShowcaseFeedPage } = await import('@/lib/showcase-feed');
    const page = await getShowcaseFeedPage({
      category: 'all',
      sort: 'recent',
      offset: 0,
      limit: 12,
      viewerUserId: 'buyer-1',
    });

    expect(page.items).toHaveLength(1);
    expect(page.items[0].canRemix).toBe(true);
  });

  it('does not send synthetic generation recipe asset ids to uuid purchase lookups', async () => {
    resourceBundlesState = [];
    generationModelsState = [{
      id: 'gen-1',
      model: 'nano-banana-2',
      category: 'image',
      prompt: 'SECRET_LEGACY_PROMPT',
      workflow_settings: {
        model: 'nano-banana-2',
        aspectRatio: '9:16',
        elements: [{
          id: 'element-1',
          displayName: 'Image input',
          handle: '@alisa',
          storagePath: 'generation_inputs/user-1/gen-1/legacy-reference.png',
        }],
      },
    }];

    const { getShowcaseFeedPage } = await import('@/lib/showcase-feed');
    const page = await getShowcaseFeedPage({
      category: 'all',
      sort: 'recent',
      offset: 0,
      limit: 12,
      viewerUserId: 'viewer-1',
    });

    expect(page.items[0].asset?.id).toBe('generation-recipe:post-1');
    expect(lastPurchaseBundleIds ?? []).toEqual([]);
  });

  it('keeps remix access disabled for unrelated viewers of remix-enabled bundles', async () => {
    const { getShowcaseFeedPage } = await import('@/lib/showcase-feed');
    const page = await getShowcaseFeedPage({
      category: 'all',
      sort: 'recent',
      offset: 0,
      limit: 12,
      viewerUserId: 'viewer-2',
    });

    expect(page.items).toHaveLength(1);
    expect(page.items[0].canRemix).toBe(false);
  });

  it('returns mixed posts when filtering by text', async () => {
    postsState = [
      {
        id: 'post-text',
        output_url: null,
        showcase_asset_path: null,
        prompt: null,
        title: 'Three hooks that keep working',
        body: 'Open with tension.\nKeep the first line short.',
        category: 'text',
        post_format: 'text',
        save_count: 5,
        remix_count: 0,
        created_at: '2026-03-20T10:00:00.000Z',
        user_id: 'user-1',
        visibility: 'public',
        source_kind: 'manual',
        source_tool: null,
        generation_id: null,
      },
      {
        id: 'post-mixed',
        output_url: 'generated_videos/user-1/example.mp4',
        showcase_asset_path: null,
        prompt: 'Keep cuts fast.',
        title: 'Winning cutdown',
        body: 'This structure pulled watch time up.',
        category: 'video',
        post_format: 'mixed',
        save_count: 4,
        remix_count: 1,
        created_at: '2026-03-19T10:00:00.000Z',
        user_id: 'user-1',
        visibility: 'public',
        source_kind: 'external',
        source_tool: 'Runway',
        generation_id: null,
      },
    ];
    generationModelsState = [];
    resourceBundlesState = [];

    const { getShowcaseFeedPage } = await import('@/lib/showcase-feed');
    const page = await getShowcaseFeedPage({
      category: 'text',
      sort: 'recent',
      offset: 0,
      limit: 12,
    });

    expect(page.items.map((item) => item.id)).toEqual(['post-text', 'post-mixed']);
    expect(page.items[0].postFormat).toBe('text');
    expect(page.items[0].mediaUrl).toBeNull();
    expect(page.items[0].canRemix).toBe(false);
    expect(page.items[1].postFormat).toBe('mixed');
    expect(page.items[1].mediaKind).toBe('video');
  });

  it('continues scanning until unlock filters find matching posts', async () => {
    postsState = [
      ...Array.from({ length: 55 }, (_, index) => createPostRow({
        id: `plain-${index}`,
        created_at: `2026-03-20T10:${String(55 - index).padStart(2, '0')}:00.000Z`,
      })),
      createPostRow({
        id: 'older-paid',
        created_at: '2026-03-19T10:00:00.000Z',
      }),
    ];
    generationModelsState = [];
    resourceBundlesState = [
      {
        id: 'bundle-paid',
        post_id: 'older-paid',
        title: 'Older paid workflow',
        access_mode: 'paid',
        price_usd_cents: 900,
        preview_text: 'The full process.',
        allow_remix: false,
        sales_count: 4,
        status: 'published',
      },
    ];

    const { getShowcaseFeedPage } = await import('@/lib/showcase-feed');
    const page = await getShowcaseFeedPage({
      category: 'all',
      sort: 'recent',
      offset: 0,
      limit: 1,
      unlock: 'paid',
    });

    expect(page.items.map((item) => item.id)).toEqual(['older-paid']);
    expect(page.pageInfo.hasMore).toBe(false);
  });

  it('sorts top sales across all candidate posts before slicing', async () => {
    postsState = [
      ...Array.from({ length: 55 }, (_, index) => createPostRow({
        id: `low-sale-${index}`,
        created_at: `2026-03-20T10:${String(55 - index).padStart(2, '0')}:00.000Z`,
      })),
      createPostRow({
        id: 'older-best-seller',
        created_at: '2026-03-19T10:00:00.000Z',
      }),
    ];
    generationModelsState = [];
    resourceBundlesState = [
      ...postsState
        .filter((post) => post.id.startsWith('low-sale-'))
        .map((post) => ({
          id: `bundle-${post.id}`,
          post_id: post.id,
          title: `Bundle ${post.id}`,
          access_mode: 'paid' as const,
          price_usd_cents: 900,
          preview_text: 'A smaller seller.',
          allow_remix: false,
          sales_count: 1,
          status: 'published' as const,
        })),
      {
        id: 'bundle-best',
        post_id: 'older-best-seller',
        title: 'Best seller',
        access_mode: 'paid',
        price_usd_cents: 1900,
        preview_text: 'The winning workflow.',
        allow_remix: false,
        sales_count: 42,
        status: 'published',
      },
    ];

    const { getShowcaseFeedPage } = await import('@/lib/showcase-feed');
    const page = await getShowcaseFeedPage({
      category: 'all',
      sort: 'top-sales',
      offset: 0,
      limit: 1,
    });

    expect(page.items.map((item) => item.id)).toEqual(['older-best-seller']);
    expect(page.items[0].asset?.salesCount).toBe(42);
  });

  it('returns legacy generation video preview urls in fallback feed items', async () => {
    postsSchemaMissingState = true;
    resourceBundlesState = [];
    generationModelsState = [{
      id: 'legacy-video',
      model: 'kling-3.0-video',
      output_url: 'generated_videos/user-1/legacy-video.mp4',
      showcase_asset_path: null,
      preview_url: 'generated_videos/user-1/legacy-video.preview.webp',
      category: 'video',
      prompt: 'A public video generation.',
      title: 'Legacy Video',
      save_count: 2,
      remix_count: 1,
      created_at: '2026-03-18T10:00:00.000Z',
      user_id: 'user-1',
      is_public: true,
      status: 'succeeded',
    }];

    const { getShowcaseFeedPage } = await import('@/lib/showcase-feed');
    const page = await getShowcaseFeedPage({
      category: 'all',
      sort: 'recent',
      offset: 0,
      limit: 12,
    });

    expect(page.items).toHaveLength(1);
    expect(page.items[0].mediaUrl).toBe('https://proxy.example.com/generated_videos/user-1/legacy-video.mp4');
    expect(page.items[0].mediaItems?.[0]).toMatchObject({
      mediaKind: 'video',
      previewUrl: 'https://proxy.example.com/generated_videos/user-1/legacy-video.preview.webp',
    });
  });
});
