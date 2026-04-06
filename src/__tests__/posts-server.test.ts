import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MarketplaceAssetRow = {
  id: string;
  post_id: string;
  type: 'workflow' | 'prompt_pack' | 'guide';
  title: string;
  price_usd_cents: number;
  status: 'active' | 'unlisted' | 'draft';
};

let marketplaceAssetsState: MarketplaceAssetRow[] = [];

function createThenableQuery<T extends Record<string, unknown>>(rows: T[]) {
  const filters: Array<(row: T) => boolean> = [];

  const applyFilters = () =>
    rows.filter((row) => filters.every((filter) => filter(row)));

  const query = {
    select() {
      return query;
    },
    in(column: string, values: unknown[]) {
      filters.push((row) => values.includes(row[column]));
      return query;
    },
    eq(column: string, value: unknown) {
      filters.push((row) => row[column] === value);
      return query;
    },
    then(resolve: (value: { data: T[]; error: null }) => void) {
      resolve({
        data: applyFilters(),
        error: null,
      });
    },
  };

  return query;
}

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => ({
    from(table: string) {
      if (table !== 'marketplace_assets') {
        throw new Error(`Unexpected table access: ${table}`);
      }

      return createThenableQuery(marketplaceAssetsState);
    },
  }),
  resolveStoredMediaUrl: vi.fn(),
}));

describe('posts-server marketplace summaries', () => {
  beforeEach(() => {
    vi.resetModules();
    marketplaceAssetsState = [
      {
        id: 'asset-active',
        post_id: 'post-1',
        type: 'workflow',
        title: 'Public workflow',
        price_usd_cents: 1900,
        status: 'active',
      },
      {
        id: 'asset-unlisted',
        post_id: 'post-1',
        type: 'guide',
        title: 'Hidden guide',
        price_usd_cents: 900,
        status: 'unlisted',
      },
    ];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('only returns active asset summaries for public post surfaces', async () => {
    const { getMarketplaceAssetSummaryMap } = await import('@/lib/posts-server');
    const assetMap = await getMarketplaceAssetSummaryMap(['post-1']);

    expect(assetMap.get('post-1')).toEqual({
      id: 'asset-active',
      type: 'workflow',
      title: 'Public workflow',
      priceUsdCents: 1900,
    });
  });
});
