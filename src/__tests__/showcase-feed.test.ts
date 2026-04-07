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
  source_kind: 'ugc_copy' | 'external' | 'manual';
  source_tool: string | null;
  generation_id: string | null;
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
  allow_remix: boolean;
  status: 'published' | 'draft';
};

let profilesState: ProfileRow[] = [];
let postsState: PostRow[] = [];
let generationModelsState: GenerationModelRow[] = [];
let resourceBundlesState: ResourceBundleRow[] = [];

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
                Object.entries(filters).every(([key, value]) => (row as Record<string, unknown>)[key] === value)
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
        source_kind: 'ugc_copy',
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
    expect(page.items[0].sourceKind).toBe('ugc_copy');
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
});
