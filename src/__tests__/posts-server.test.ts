import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

let resourceBundlesState: ResourceBundleRow[] = [];

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
      if (table !== 'post_resource_bundles' && table !== 'marketplace_assets') {
        throw new Error(`Unexpected table access: ${table}`);
      }

      return createThenableQuery(resourceBundlesState);
    },
  }),
  resolveStoredMediaUrl: vi.fn(),
}));

describe('posts-server marketplace summaries', () => {
  beforeEach(() => {
    vi.resetModules();
    resourceBundlesState = [
      {
        id: 'asset-active',
        post_id: 'post-1',
        title: 'Public workflow',
        access_mode: 'paid',
        price_usd_cents: 1900,
        preview_text: 'Reusable launch workflow',
        allow_remix: true,
        status: 'published',
      },
      {
        id: 'asset-unlisted',
        post_id: 'post-1',
        title: 'Hidden guide',
        access_mode: 'paid',
        price_usd_cents: 900,
        preview_text: 'Hidden guide preview',
        allow_remix: false,
        status: 'draft',
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
      postId: 'post-1',
      title: 'Public workflow',
      accessMode: 'paid',
      priceUsdCents: 1900,
      previewText: 'Reusable launch workflow',
      allowRemix: true,
    });
  });
});
