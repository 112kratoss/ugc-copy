import { describe, expect, it, vi } from 'vitest';

import { importMarketplaceWorkflowAssetForRoute } from '@/lib/marketplace-asset-import-service';
import { createStarterGraph } from '@/lib/workflow-canvas';

function createAdminClient({
  asset = {
    id: 'asset-1',
    seller_user_id: 'seller-1',
    type: 'workflow',
    title: 'Launch Workflow',
  } as Record<string, unknown> | null,
  purchase = { asset_id: 'asset-1' } as Record<string, unknown> | null,
  workflowGraph = createStarterGraph() as unknown,
  rateLimitAllowed = true,
} = {}) {
  const rpc = vi.fn(async () => ({
    data: {
      allowed: rateLimitAllowed,
      limit: 30,
      remaining: rateLimitAllowed ? 29 : 0,
      retryAfterSeconds: rateLimitAllowed ? 0 : 43,
      resetAt: '2026-06-22T06:30:00.000Z',
    },
    error: null,
  }));
  const tableReads: string[] = [];

  const from = vi.fn((table: string) => {
    tableReads.push(table);
    const filters: Record<string, unknown> = {};
    const query = {
      select() {
        return query;
      },
      eq(column: string, value: unknown) {
        filters[column] = value;
        return query;
      },
      async maybeSingle() {
        if (table === 'marketplace_assets') {
          return { data: asset, error: null };
        }

        if (table === 'marketplace_purchases') {
          return { data: purchase, error: null };
        }

        if (table === 'marketplace_asset_content') {
          return {
            data: workflowGraph ? { workflow_graph: workflowGraph } : null,
            error: null,
          };
        }

        throw new Error(`Unexpected admin table: ${table}`);
      },
    };

    return query;
  });

  return {
    client: { rpc, from } as never,
    rpc,
    from,
    tableReads,
  };
}

function createUserClient({
  legacyLifecycleFallback = false,
  historyError = null as Error | null,
} = {}) {
  const canvasInserts: Record<string, unknown>[] = [];
  const canvasSelects: string[] = [];
  const historyInserts: Record<string, unknown>[] = [];
  let workflowInsertAttempts = 0;

  const from = vi.fn((table: string) => {
    if (table === 'workflow_canvases') {
      return {
        insert(payload: Record<string, unknown>) {
          workflowInsertAttempts += 1;
          canvasInserts.push(payload);
          return {
            select(selectClause: string) {
              canvasSelects.push(selectClause);
              return {
                async single() {
                  if (legacyLifecycleFallback && workflowInsertAttempts === 1) {
                    return {
                      data: null,
                      error: {
                        code: 'PGRST204',
                        message: "Could not find the 'status' column",
                      },
                    };
                  }

                  return {
                    data: {
                      id: 'canvas-1',
                      title: payload.title,
                      graph: payload.graph,
                      created_at: '2026-06-22T06:00:00.000Z',
                      updated_at: '2026-06-22T06:00:00.000Z',
                      revision: 1,
                      status: payload.status,
                      published_at: null,
                    },
                    error: null,
                  };
                },
              };
            },
          };
        },
      };
    }

    if (table === 'workflow_canvas_history') {
      return {
        async insert(payload: Record<string, unknown>) {
          historyInserts.push(payload);
          return { error: historyError };
        },
      };
    }

    throw new Error(`Unexpected user table: ${table}`);
  });

  return {
    client: { from } as never,
    from,
    canvasInserts,
    canvasSelects,
    historyInserts,
  };
}

describe('importMarketplaceWorkflowAssetForRoute', () => {
  it('rate limits before marketplace asset lookup or canvas creation', async () => {
    const admin = createAdminClient({ rateLimitAllowed: false });
    const user = createUserClient();

    const result = await importMarketplaceWorkflowAssetForRoute({
      adminSupabase: admin.client,
      assetId: 'asset-1',
      userId: 'buyer-1',
      userSupabase: user.client,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 429,
      code: 'RATE_LIMITED',
      retryAfterSeconds: 43,
    });
    expect(admin.rpc).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'marketplace-asset:import',
      p_subject_key: 'buyer-1',
      p_limit: 30,
      p_window_seconds: 600,
    });
    expect(admin.tableReads).toEqual([]);
    expect(user.canvasInserts).toHaveLength(0);
  });

  it('requires purchase before importing another seller workflow', async () => {
    const admin = createAdminClient({ purchase: null });
    const user = createUserClient();

    await expect(importMarketplaceWorkflowAssetForRoute({
      adminSupabase: admin.client,
      assetId: 'asset-1',
      userId: 'buyer-1',
      userSupabase: user.client,
    })).resolves.toEqual({
      ok: false,
      status: 403,
      body: { error: 'Purchase required before importing this workflow.' },
    });
    expect(admin.tableReads).toContain('marketplace_purchases');
    expect(user.canvasInserts).toHaveLength(0);
  });

  it('imports purchased workflow content into a draft canvas and writes history', async () => {
    const admin = createAdminClient();
    const user = createUserClient();

    const result = await importMarketplaceWorkflowAssetForRoute({
      adminSupabase: admin.client,
      assetId: 'asset-1',
      userId: 'buyer-1',
      userSupabase: user.client,
    });

    expect(result.ok).toBe(true);
    expect(result).toMatchObject({
      ok: true,
      body: {
        success: true,
        redirectTo: '/create-workflow',
        canvas: {
          id: 'canvas-1',
          title: 'Copy of Launch Workflow',
          status: 'draft',
          published_at: null,
        },
      },
    });
    expect(user.canvasInserts[0]).toMatchObject({
      user_id: 'buyer-1',
      title: 'Copy of Launch Workflow',
      status: 'draft',
    });
    expect(user.historyInserts[0]).toMatchObject({
      canvas_id: 'canvas-1',
      user_id: 'buyer-1',
      title: 'Copy of Launch Workflow',
      revision: 1,
      kind: 'draft',
    });
  });

  it('falls back to legacy workflow canvas inserts when lifecycle columns are missing', async () => {
    const admin = createAdminClient();
    const user = createUserClient({ legacyLifecycleFallback: true });

    const result = await importMarketplaceWorkflowAssetForRoute({
      adminSupabase: admin.client,
      assetId: 'asset-1',
      userId: 'buyer-1',
      userSupabase: user.client,
    });

    expect(result).toMatchObject({
      ok: true,
      body: {
        canvas: {
          status: 'draft',
          published_at: null,
        },
      },
    });
    expect(user.canvasInserts).toHaveLength(2);
    expect(user.canvasInserts[0]).toHaveProperty('status', 'draft');
    expect(user.canvasInserts[1]).not.toHaveProperty('status');
  });
});
