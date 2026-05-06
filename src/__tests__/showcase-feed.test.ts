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

let profilesState: ProfileRow[] = [];
let postsState: PostRow[] = [];
let generationModelsState: GenerationModelRow[] = [];
let resourceBundlesState: ResourceBundleRow[] = [];
let postSavesState: PostSaveRow[] = [];
let postResourceBundlePurchasesState: PostResourceBundlePurchaseRow[] = [];

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
      })),
    },
    from(table: string) {
      if (table === 'posts') {
        const filters: Record<string, unknown> = {};
        const sorts: Array<{ column: keyof PostRow; ascending: boolean }> = [];
        let textFilter = false;

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

      if (table === 'generations') {
        return {
          select() {
            return {
              async in(_column: string, values: unknown[]) {
                return {
                  data: generationModelsState.filter((row) => values.includes(row.id)),
                  error: null,
                };
              },
            };
          },
        };
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
    generationModelsState = [
      {
        id: 'gen-1',
        model: 'nano-banana-2',
      },
    ];
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
      previewText: 'Unlock the exact prompt stack.',
      allowRemix: true,
    });
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
});
