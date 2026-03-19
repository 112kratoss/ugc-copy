import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ProfileRow = {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
};

type GenerationRow = {
  id: string;
  output_url: string | null;
  showcase_asset_path: string | null;
  model: string;
  prompt: string | null;
  title: string | null;
  category: 'image' | 'video' | 'motion' | 'ugc-ad' | null;
  save_count: number | null;
  remix_count: number | null;
  created_at: string;
  user_id: string | null;
  is_public: boolean;
  status: string;
};

let profilesState: ProfileRow[] = [];
let generationsState: GenerationRow[] = [];

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
      if (table === 'generations') {
        const filters: Record<string, unknown> = {};
        let sortColumn = 'created_at';
        let sortAscending = false;

        const query = {
          select() {
            return query;
          },
          eq(column: string, value: unknown) {
            filters[column] = value;
            return query;
          },
          not() {
            return query;
          },
          order(column: string, options: { ascending: boolean }) {
            sortColumn = column;
            sortAscending = options.ascending;
            return query;
          },
          async range(start: number, end: number) {
            const rows = generationsState
              .filter((row) =>
                Object.entries(filters).every(([key, value]) => (row as Record<string, unknown>)[key] === value)
              )
              .sort((left, right) => {
                const leftValue = (left as Record<string, unknown>)[sortColumn];
                const rightValue = (right as Record<string, unknown>)[sortColumn];

                if (leftValue === rightValue) {
                  return 0;
                }

                return sortAscending ? Number(leftValue > rightValue) - Number(leftValue < rightValue) : Number(leftValue < rightValue) - Number(leftValue > rightValue);
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
    generationsState = [
      {
        id: 'gen-1',
        output_url: 'generated_images/user-1/example.jpg',
        showcase_asset_path: null,
        model: 'nano-banana-2',
        prompt: 'A creator style hero shot.',
        title: 'Hero Shot',
        category: 'image',
        save_count: 8,
        remix_count: 3,
        created_at: '2026-03-19T10:00:00.000Z',
        user_id: 'user-1',
        is_public: true,
        status: 'succeeded',
      },
    ];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('includes creator usernames on feed items', async () => {
    const { getShowcaseFeedPage } = await import('@/lib/showcase-feed');
    const page = await getShowcaseFeedPage({
      category: 'all',
      sort: 'recent',
      offset: 0,
      limit: 12,
    });

    expect(page.items).toHaveLength(1);
    expect(page.items[0].creator.username).toBe('creator-name');
    expect(page.items[0].creator.name).toBe('Creator Name');
  });
});
