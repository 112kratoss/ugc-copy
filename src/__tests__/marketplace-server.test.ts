import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MarketplaceAssetRow = {
  id: string;
  seller_user_id: string;
  post_id: string | null;
  type: 'workflow' | 'prompt_pack' | 'guide';
  title: string;
  description: string;
  preview: string;
  price_usd_cents: number;
  status: 'active' | 'draft' | 'unlisted' | 'deleted';
  sales_count: number;
  earnings_usd_cents: number;
  created_at: string;
  updated_at: string;
};

type ProfileRow = {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
};

type PostRow = {
  id: string;
  title: string | null;
  body: string | null;
  category: 'image' | 'video' | 'motion' | 'ugc-ad' | 'text';
  post_format: 'text' | 'media' | 'mixed';
  visibility: 'public' | 'unlisted' | 'private';
  showcase_asset_path: string | null;
  output_url: string | null;
  source_kind: 'magicbooklet' | 'external' | 'manual';
  source_tool: string | null;
};

let marketplaceAssetsState: MarketplaceAssetRow[] = [];
let profilesState: ProfileRow[] = [];
let postsState: PostRow[] = [];
let marketplaceAssetContentState: Array<{
  asset_id: string;
  workflow_graph: null;
  prompt_pack: string | null;
  guide_markdown: string | null;
}> = [];

function compareValues(
  left: string | number | null | undefined,
  right: string | number | null | undefined
) {
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

function createThenableQuery<T extends Record<string, unknown>>(rows: T[]) {
  const filters: Array<(row: T) => boolean> = [];
  const sorts: Array<{ column: keyof T; ascending: boolean }> = [];

  const apply = () =>
    [...rows]
      .filter((row) => filters.every((filter) => filter(row)))
      .sort((left, right) => {
        for (const sort of sorts) {
          const comparison = compareValues(
            left[sort.column] as string | number | null | undefined,
            right[sort.column] as string | number | null | undefined
          );
          if (comparison !== 0) {
            return sort.ascending ? comparison : -comparison;
          }
        }

        return 0;
      });

  const query = {
    select() {
      return query;
    },
    eq(column: string, value: unknown) {
      filters.push((row) => row[column] === value);
      return query;
    },
    neq(column: string, value: unknown) {
      filters.push((row) => row[column] !== value);
      return query;
    },
    in(column: string, values: unknown[]) {
      filters.push((row) => values.includes(row[column]));
      return query;
    },
    order(column: string, options: { ascending: boolean }) {
      sorts.push({ column: column as keyof T, ascending: options.ascending });
      return query;
    },
    async maybeSingle() {
      return {
        data: apply()[0] ?? null,
        error: null,
      };
    },
    async range(start: number, end: number) {
      return {
        data: apply().slice(start, end + 1),
        error: null,
      };
    },
    then(resolve: (value: { data: T[]; error: null }) => void) {
      resolve({
        data: apply(),
        error: null,
      });
    },
  };

  return query;
}

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => ({
    from(table: string) {
      if (table === 'marketplace_assets') {
        return createThenableQuery(marketplaceAssetsState);
      }

      if (table === 'profiles') {
        return createThenableQuery(profilesState);
      }

      if (table === 'posts') {
        return createThenableQuery(postsState);
      }

      if (table === 'marketplace_asset_content') {
        return createThenableQuery(marketplaceAssetContentState);
      }

      throw new Error(`Unexpected table access: ${table}`);
    },
    storage: {
      from: vi.fn(() => ({
        getPublicUrl: vi.fn((filePath: string) => ({
          data: {
            publicUrl: `https://cdn.example.com/${filePath}`,
          },
        })),
      })),
    },
  }),
  resolveStoredMediaUrl: vi.fn(async (_client, outputUrl: string) => outputUrl),
}));

describe('marketplace server visibility hardening', () => {
  beforeEach(() => {
    vi.resetModules();
    marketplaceAssetsState = [
      {
        id: 'asset-1',
        seller_user_id: 'seller-1',
        post_id: 'post-private',
        type: 'workflow',
        title: 'Secret workflow',
        description: 'Private proof post attached.',
        preview: 'Preview text',
        price_usd_cents: 1900,
        status: 'active',
        sales_count: 3,
        earnings_usd_cents: 5700,
        created_at: '2026-04-06T09:00:00.000Z',
        updated_at: '2026-04-06T09:00:00.000Z',
      },
    ];
    profilesState = [
      {
        id: 'seller-1',
        username: 'seller-one',
        display_name: 'Seller One',
        avatar_url: null,
      },
    ];
    postsState = [
      {
        id: 'post-private',
        title: 'Private proof',
        body: 'Only the seller should keep seeing this proof post.',
        category: 'image',
        post_format: 'media',
        visibility: 'private',
        showcase_asset_path: null,
        output_url: 'https://cdn.example.com/private-proof.jpg',
        source_kind: 'magicbooklet',
        source_tool: null,
      },
    ];
    marketplaceAssetContentState = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hides non-public linked posts on public marketplace list and detail pages', async () => {
    const { getMarketplaceAssetDetail, getMarketplaceAssetList } = await import('@/lib/marketplace-server');

    const list = await getMarketplaceAssetList({
      offset: 0,
      limit: 24,
    });
    const detail = await getMarketplaceAssetDetail('asset-1', {
      viewerUserId: null,
    });

    expect(list.items).toHaveLength(1);
    expect(list.items[0].post).toBeNull();
    expect(detail?.post).toBeNull();
  });

  it('keeps linked post context visible for the seller on private reads', async () => {
    const { getMarketplaceAssetDetail } = await import('@/lib/marketplace-server');

    const detail = await getMarketplaceAssetDetail('asset-1', {
      viewerUserId: 'seller-1',
    });

    expect(detail?.viewerIsSeller).toBe(true);
    expect(detail?.post).toMatchObject({
      id: 'post-private',
      title: 'Private proof',
    });
  });
});
