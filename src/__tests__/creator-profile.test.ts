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
  source_kind: 'ugc_copy' | 'external' | 'manual';
  source_tool: string | null;
  user_id: string;
  visibility: 'public' | 'unlisted' | 'private';
  archived_at?: string | null;
};

let profilesState: ProfileRow[] = [];
let generationsState: GenerationRow[] = [];
let postsState: PostRow[] = [];

function createServiceClientMock() {
  return {
    storage: {
      from: vi.fn(() => ({
        getPublicUrl: vi.fn((path: string) => ({
          data: { publicUrl: `https://cdn.example.com/${path}` },
        })),
      })),
    },
    from(table: string) {
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
              async limit(limit: number) {
                const rows = generationsState
                  .filter((row) =>
                    Object.entries(filters).every(([key, value]) =>
                      key === 'archived_at' && value === null
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
          select() {
            const filters: Record<string, unknown> = {};
            return {
              eq(column: string, value: unknown) {
                filters[column] = value;
                return this;
              },
              is(column: string, value: unknown) {
                filters[column] = value;
                return this;
              },
              order() {
                return this;
              },
              async limit(limit: number) {
                const rows = postsState
                  .filter((row) =>
                    Object.entries(filters).every(([key, value]) =>
                      key === 'archived_at' && value === null
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

      if (table === 'marketplace_assets') {
        return {
          select() {
            let postIds: unknown[] = [];
            let status: unknown = null;

            return {
              in(column: string, values: unknown[]) {
                if (column === 'post_id') {
                  postIds = values;
                }
                return this;
              },
              async eq(column: string, value: unknown) {
                if (column === 'status') {
                  status = value;
                }

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
        source_kind: 'ugc_copy',
        source_tool: null,
        visibility: 'public',
      },
    ];
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
    expect(data?.stats.totalSaves).toBe(12);
  });

  it('returns null for unknown usernames', async () => {
    const { getCreatorProfilePageData } = await import('@/lib/creator-profile');
    const data = await getCreatorProfilePageData('missing-user');

    expect(data).toBeNull();
  });
});
