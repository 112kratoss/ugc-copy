import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

let resourceBundlesState: ResourceBundleRow[] = [];
let rpcErrorState: unknown = null;
let lastRpcResponseState: Array<Record<string, unknown>> | null = null;
let rpcCallsState: string[] = [];
let tableAccessesState: string[] = [];
let selectedColumnsState: string[] = [];
let tableQueryErrorState: unknown = null;

function createThenableQuery<T extends Record<string, unknown>>(rows: T[]) {
  const filters: Array<(row: T) => boolean> = [];

  const applyFilters = () =>
    rows.filter((row) => filters.every((filter) => filter(row)));

  const query = {
    select(columns?: string) {
      if (typeof columns === 'string') selectedColumnsState.push(columns);
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
    then(resolve: (value: { data: T[] | null; error: unknown }) => void) {
      resolve({
        data: tableQueryErrorState ? null : applyFilters(),
        error: tableQueryErrorState,
      });
    },
  };

  return query;
}

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => ({
    async rpc(name: string) {
      rpcCallsState.push(name);
      if (rpcErrorState) return { data: null, error: rpcErrorState };
      if (name !== 'get_public_post_resource_bundle_summaries') {
        return {
          data: null,
          error: {
            code: 'PGRST202',
            message: `Could not find the function public.${name} in the schema cache`,
          },
        };
      }

      lastRpcResponseState = resourceBundlesState.map((row) => (
        row.status === 'published'
          ? { ...row }
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
      ));
      return { data: lastRpcResponseState, error: null };
    },
    from(table: string) {
      tableAccessesState.push(table);
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
    rpcErrorState = null;
    lastRpcResponseState = null;
    rpcCallsState = [];
    tableAccessesState = [];
    selectedColumnsState = [];
    tableQueryErrorState = null;
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
        post_id: 'post-2',
        title: 'Hidden guide',
        access_mode: 'paid',
        price_usd_cents: 900,
        preview_text: 'Hidden guide preview',
        prompt_text: 'DRAFT_SECRET_PROMPT',
        notes_markdown: 'DRAFT_SECRET_NOTES',
        workflow_snapshot: { secret: 'DRAFT_SECRET_WORKFLOW' },
        attachments: [{ storagePath: 'DRAFT_SECRET_FILE' }],
        resource_items: [{ type: 'prompt', textContent: 'DRAFT_SECRET_ITEM' }],
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

    expect(assetMap.get('post-1')).toEqual(expect.objectContaining({
      id: 'asset-active',
      postId: 'post-1',
      title: 'Public workflow',
      accessMode: 'paid',
      priceUsdCents: 1900,
      previewText: 'Reusable launch workflow',
      allowRemix: true,
    }));
    expect(assetMap.get('post-1')?.lockedPreview?.itemPreviews).toEqual([
      expect.objectContaining({
        type: 'remix_access',
        title: 'Remix access',
        remixUse: 'direct_remix',
      }),
    ]);
  });

  it('reports bundle presence for unpublished bundles without exposing their summaries', async () => {
    const { getMarketplaceAssetSummaryHydration } = await import('@/lib/posts-server');
    const hydration = await getMarketplaceAssetSummaryHydration(['post-1', 'post-2']);

    expect(Array.from(hydration.assetMap.keys())).toEqual(['post-1']);
    expect(Array.from(hydration.knownBundlePostIds ?? []).sort()).toEqual(['post-1', 'post-2']);
    expect(rpcCallsState).toEqual(['get_public_post_resource_bundle_summaries']);
    expect(tableAccessesState).toEqual([]);
    expect(JSON.stringify(lastRpcResponseState)).not.toContain('DRAFT_SECRET');
  });

  it('uses a presence-first fallback that never selects draft details', async () => {
    rpcErrorState = {
      code: 'PGRST202',
      message: 'Could not find the function public.get_public_post_resource_bundle_summaries(p_post_ids) in the schema cache',
    };
    const { getMarketplaceAssetSummaryHydration } = await import('@/lib/posts-server');
    const hydration = await getMarketplaceAssetSummaryHydration(['post-1', 'post-2']);

    expect(Array.from(hydration.assetMap.keys())).toEqual(['post-1']);
    expect(Array.from(hydration.knownBundlePostIds ?? []).sort()).toEqual(['post-1', 'post-2']);
    expect(tableAccessesState).toEqual(['post_resource_bundles', 'post_resource_bundles']);
    expect(selectedColumnsState[0]).toBe('post_id, status');
    expect(selectedColumnsState[1]).toContain('prompt_text');
  });

  it('fails closed without table fallback on non-schema RPC errors', async () => {
    rpcErrorState = {
      code: 'XX000',
      message: 'temporary database failure',
    };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { getMarketplaceAssetSummaryHydration } = await import('@/lib/posts-server');
    const hydration = await getMarketplaceAssetSummaryHydration(['post-1', 'post-2']);

    expect(hydration.assetMap.size).toBe(0);
    expect(Array.from(hydration.knownBundlePostIds ?? []).sort()).toEqual(['post-1', 'post-2']);
    expect(tableAccessesState).toEqual([]);
    // The failure is now reported through the structured logger, so assert the
    // stable event name and the surfaced error rather than a message string.
    const summaryLog = JSON.parse(consoleError.mock.calls[0][0] as string);
    expect(summaryLog.msg).toBe('failed_to_load_public_post_resource_bundle_summaries');
    expect(summaryLog.level).toBe('error');
    expect(summaryLog.errorMessage).toBe(rpcErrorState.message);
  });

  it('fails closed when the missing-RPC presence fallback has a database error', async () => {
    rpcErrorState = {
      code: 'PGRST202',
      message: 'Could not find the function public.get_public_post_resource_bundle_summaries(p_post_ids) in the schema cache',
    };
    tableQueryErrorState = {
      code: 'XX000',
      message: 'temporary presence query failure',
    };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { getMarketplaceAssetSummaryHydration } = await import('@/lib/posts-server');
    const hydration = await getMarketplaceAssetSummaryHydration(['post-1', 'post-2']);

    expect(hydration.assetMap.size).toBe(0);
    expect(Array.from(hydration.knownBundlePostIds ?? []).sort()).toEqual(['post-1', 'post-2']);
    expect(tableAccessesState).toEqual(['post_resource_bundles']);
    expect(selectedColumnsState).toEqual(['post_id, status']);
    const presenceLog = JSON.parse(consoleError.mock.calls[0][0] as string);
    expect(presenceLog.msg).toBe('failed_to_load_post_resource_bundle_presence');
    expect(presenceLog.level).toBe('error');
    expect(presenceLog.errorMessage).toBe(tableQueryErrorState.message);
  });
});
