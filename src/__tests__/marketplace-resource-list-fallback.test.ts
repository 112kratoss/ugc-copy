import { beforeEach, describe, expect, it, vi } from 'vitest';

type TestBundleRow = {
  id: string;
  post_id: string;
  owner_user_id: string;
  legacy_asset_id: null;
  access_mode: 'free';
  status: 'published';
  title: string;
  summary: string;
  preview_text: string;
  prompt_text: string;
  notes_markdown: null;
  workflow_share_url: null;
  workflow_snapshot: null;
  attachments: unknown[];
  allow_remix: boolean;
  resource_sections: unknown[];
  resource_items: unknown[];
  price_usd_cents: number;
  sales_count: number;
  earnings_usd_cents: number;
  created_at: string;
  updated_at: string;
};

let bundleRows: TestBundleRow[] = [];
let rangeCalls: Array<{ start: number; end: number }> = [];
let orderCalls: Array<{ column: string; ascending: boolean }> = [];
let linkedPostHydrationCalls: string[][] = [];
let selectedBundleColumns: string[] = [];
let simulateLegacyResourceColumns = false;
let rpcBundleRows: TestBundleRow[] | null = null;
let rpcCalls: Array<{ offset: number; limit: number }> = [];
let hiddenLinkedPostIds = new Set<string>();

function buildLinkedPost(postId: string) {
  return {
    id: postId,
    generation_id: null,
    title: `Published result for ${postId}`,
    body: 'A detailed public result that gives buyers enough proof to evaluate the unlock.',
    category: 'image',
    post_format: 'media',
    visibility: 'public',
    archived_at: null,
    review_status: 'visible',
    showcase_asset_path: null,
    output_url: `https://media.example.com/${postId}.jpg`,
    source_kind: 'magicbooklet',
    source_tool: 'magicbooklet',
    source_tool_slug: 'magicbooklet',
    save_count: 0,
    remix_count: 0,
    share_visit_count: 0,
  };
}

vi.mock('@/lib/post-media', () => ({
  loadPostMediaItemsMap: vi.fn(async () => new Map()),
}));

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => ({
    rpc: vi.fn(async (_name: string, params: { p_offset: number; p_limit: number }) => {
      if (rpcBundleRows) {
        rpcCalls.push({ offset: params.p_offset, limit: params.p_limit });
        return {
          data: rpcBundleRows.slice(params.p_offset, params.p_offset + params.p_limit),
          error: null,
        };
      }

      return {
        data: null,
        error: {
          code: 'PGRST202',
          message: 'Could not find the function public.list_marketplace_resource_bundles',
        },
      };
    }),
    storage: {
      from: vi.fn(() => ({
        getPublicUrl: vi.fn((path: string) => ({
          data: { publicUrl: `https://media.example.com/${path}` },
        })),
      })),
    },
    from(table: string) {
      if (table === 'post_resource_bundles') {
        let selectedColumns = '';
        const query = {
          select(columns: string) {
            selectedColumns = columns;
            selectedBundleColumns.push(columns);
            return query;
          },
          eq() {
            return query;
          },
          order(column: string, options: { ascending: boolean }) {
            orderCalls.push({ column, ascending: options.ascending });
            return query;
          },
          async range(start: number, end: number) {
            rangeCalls.push({ start, end });
            if (simulateLegacyResourceColumns && selectedColumns.includes('resource_items')) {
              return {
                data: null,
                error: {
                  code: '42703',
                  message: 'column post_resource_bundles.resource_items does not exist',
                },
              };
            }

            return {
              data: bundleRows.slice(start, end + 1),
              error: null,
            };
          },
        };

        return query;
      }

      if (table === 'profiles') {
        return {
          select() {
            return {
              async in(_column: string, ownerIds: string[]) {
                return {
                  data: ownerIds.map((id) => ({
                    id,
                    username: 'launch-maker',
                    display_name: 'Launch Maker',
                    avatar_url: 'https://media.example.com/avatar.jpg',
                  })),
                  error: null,
                };
              },
            };
          },
        };
      }

      if (table === 'posts') {
        let postIds: string[] = [];
        const query = {
          select() {
            return query;
          },
          in(_column: string, values: string[]) {
            postIds = values;
            return query;
          },
          eq() {
            return query;
          },
          is() {
            return query;
          },
          neq() {
            return query;
          },
          then(resolve: (value: { data: ReturnType<typeof buildLinkedPost>[]; error: null }) => void) {
            linkedPostHydrationCalls.push([...postIds]);
            resolve({
              data: postIds
                .filter((postId) => !hiddenLinkedPostIds.has(postId))
                .map(buildLinkedPost),
              error: null,
            });
          },
        };

        return query;
      }

      throw new Error(`Unexpected table access: ${table}`);
    },
  }),
}));

function buildBundleRow(index: number, title: string): TestBundleRow {
  const id = String(index).padStart(3, '0');
  return {
    id: `bundle-${id}`,
    post_id: `post-${id}`,
    owner_user_id: `owner-${id}`,
    legacy_asset_id: null,
    access_mode: 'free',
    status: 'published',
    title,
    summary: 'A practical creation recipe with reusable production details.',
    preview_text: 'Unlock the complete prompt and production setup for this result.',
    prompt_text: 'Create a polished campaign visual with deliberate lighting and composition.',
    notes_markdown: null,
    workflow_share_url: null,
    workflow_snapshot: null,
    attachments: [],
    allow_remix: false,
    resource_sections: [],
    resource_items: [],
    price_usd_cents: 0,
    sales_count: 0,
    earnings_usd_cents: 0,
    created_at: '2026-07-15T00:00:00.000Z',
    updated_at: '2026-07-15T00:00:00.000Z',
  };
}

describe('marketplace resource list missing-RPC fallback batching', () => {
  beforeEach(() => {
    vi.resetModules();
    rangeCalls = [];
    orderCalls = [];
    linkedPostHydrationCalls = [];
    selectedBundleColumns = [];
    simulateLegacyResourceColumns = false;
    rpcBundleRows = null;
    rpcCalls = [];
    hiddenLinkedPostIds = new Set();
  });

  it('advances past a returned lookahead row when hydration drops an earlier row', async () => {
    rpcBundleRows = Array.from({ length: 5 }, (_, index) => (
      buildBundleRow(index, `Launch recipe ${index}`)
    ));
    hiddenLinkedPostIds.add('post-001');
    const { getMarketplaceResourceList } = await import('@/lib/post-resource-bundles-server');

    const firstPage = await getMarketplaceResourceList({ offset: 0, limit: 2 });
    const secondPage = await getMarketplaceResourceList({
      offset: firstPage.pageInfo.nextOffset ?? 0,
      limit: 2,
    });

    expect(firstPage.items.map((item) => item.postId)).toEqual(['post-000', 'post-002']);
    expect(firstPage.pageInfo).toMatchObject({ hasMore: true, nextOffset: 3 });
    expect(secondPage.items.map((item) => item.postId)).toEqual(['post-003', 'post-004']);
    expect(secondPage.pageInfo).toMatchObject({ hasMore: false, nextOffset: null });
    expect(rpcCalls).toEqual([
      { offset: 0, limit: 3 },
      { offset: 3, limit: 3 },
    ]);
  });

  it('leaves an unreturned eligible lookahead at the next page offset', async () => {
    rpcBundleRows = Array.from({ length: 5 }, (_, index) => (
      buildBundleRow(index, `Launch recipe ${index}`)
    ));
    const { getMarketplaceResourceList } = await import('@/lib/post-resource-bundles-server');

    const firstPage = await getMarketplaceResourceList({ offset: 0, limit: 2 });
    const secondPage = await getMarketplaceResourceList({
      offset: firstPage.pageInfo.nextOffset ?? 0,
      limit: 2,
    });

    expect(firstPage.items.map((item) => item.postId)).toEqual(['post-000', 'post-001']);
    expect(firstPage.pageInfo).toMatchObject({ hasMore: true, nextOffset: 2 });
    expect(secondPage.items.map((item) => item.postId)).toEqual(['post-002', 'post-003']);
    expect(secondPage.pageInfo).toMatchObject({ hasMore: true, nextOffset: 4 });
    expect(rpcCalls).toEqual([
      { offset: 0, limit: 3 },
      { offset: 2, limit: 3 },
    ]);
  });

  it('stops before hydrating a later database batch once the first batch proves hasMore', async () => {
    bundleRows = Array.from({ length: 30 }, (_, index) =>
      buildBundleRow(index, `Needle-ready launch recipe ${index}`)
    );
    const { getMarketplaceResourceList } = await import('@/lib/post-resource-bundles-server');

    const page = await getMarketplaceResourceList({
      q: 'needle-ready',
      offset: 0,
      limit: 1,
    });

    expect(page.items).toHaveLength(1);
    expect(page.pageInfo).toMatchObject({ hasMore: true, nextOffset: 1 });
    expect(rangeCalls).toEqual([{ start: 0, end: 23 }]);
    expect(linkedPostHydrationCalls).toHaveLength(1);
    expect(linkedPostHydrationCalls[0]).toHaveLength(24);
    expect(linkedPostHydrationCalls[0]).not.toContain('post-024');
    expect(orderCalls.slice(-2)).toEqual([
      { column: 'created_at', ascending: false },
      { column: 'id', ascending: false },
    ]);
  });

  it('loads the next bounded batch when hydrated filters remove the first batch', async () => {
    bundleRows = Array.from({ length: 30 }, (_, index) =>
      buildBundleRow(
        index,
        index < 24 ? `Production launch recipe ${index}` : `Needle-ready launch recipe ${index}`,
      )
    );
    const { getMarketplaceResourceList } = await import('@/lib/post-resource-bundles-server');

    const page = await getMarketplaceResourceList({
      q: 'needle-ready',
      offset: 0,
      limit: 1,
    });

    expect(page.items).toHaveLength(1);
    expect(page.items[0].postId).toBe('post-024');
    expect(page.pageInfo).toMatchObject({ hasMore: true, nextOffset: 1 });
    expect(rangeCalls).toEqual([
      { start: 0, end: 23 },
      { start: 24, end: 47 },
    ]);
    expect(linkedPostHydrationCalls.map((postIds) => postIds.length)).toEqual([24, 6]);
  });

  it('retries the same bounded range with legacy columns before hydrating it', async () => {
    simulateLegacyResourceColumns = true;
    bundleRows = Array.from({ length: 30 }, (_, index) =>
      buildBundleRow(index, `Needle-ready launch recipe ${index}`)
    );
    const { getMarketplaceResourceList } = await import('@/lib/post-resource-bundles-server');

    const page = await getMarketplaceResourceList({
      q: 'needle-ready',
      offset: 0,
      limit: 1,
    });

    expect(page.items).toHaveLength(1);
    expect(rangeCalls).toEqual([
      { start: 0, end: 23 },
      { start: 0, end: 23 },
    ]);
    expect(selectedBundleColumns[0]).toContain('resource_items');
    expect(selectedBundleColumns[1]).not.toContain('resource_items');
    expect(linkedPostHydrationCalls).toHaveLength(1);
  });

  it('caps total database scanning when hydrated filters never match', async () => {
    bundleRows = Array.from({ length: 1_200 }, (_, index) =>
      buildBundleRow(index, `Production launch recipe ${index}`)
    );
    const { getMarketplaceResourceList } = await import('@/lib/post-resource-bundles-server');

    const page = await getMarketplaceResourceList({
      q: 'never-present-query',
      offset: 0,
      limit: 48,
    });

    expect(page.items).toEqual([]);
    expect(page.pageInfo).toMatchObject({ hasMore: false, nextOffset: null });
    expect(rangeCalls).toHaveLength(11);
    expect(rangeCalls.at(-1)).toEqual({ start: 960, end: 1_008 });
    expect(linkedPostHydrationCalls.flat()).toHaveLength(1_009);
    expect(linkedPostHydrationCalls.flat()).not.toContain('post-1009');
  });
});
