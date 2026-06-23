import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { importWorkflowShareForRoute } from '@/lib/workflow-share-import-service';
import {
  createStarterGraph,
  createWorkflowShareSnapshotGraph,
} from '@/lib/workflow-canvas';

const SHARE_ID = '11111111-1111-4111-8111-111111111111';
const sourceGraph = createStarterGraph();
const sharedGraph = createWorkflowShareSnapshotGraph(sourceGraph);
const shareRow = {
  id: SHARE_ID,
  owner_user_id: 'user-1',
  source_canvas_id: 'canvas-1',
  source_revision: 3,
  title: 'Shared workflow',
  graph: sharedGraph,
  node_count: sharedGraph.nodes.length,
  edge_count: sharedGraph.edges.length,
  import_count: 2,
  created_at: '2026-04-02T10:00:00.000Z',
};

function lifecycleColumnError() {
  return { code: '42703', message: 'column workflow_canvases.status does not exist' };
}

function historyTableMissingError() {
  return { code: '42P01', message: 'relation "workflow_canvas_history" does not exist' };
}

function createUserSupabaseMock(options?: {
  fallbackInsert?: boolean;
  historyMissing?: boolean;
  shareMissing?: boolean;
}) {
  const insertedCanvases: Array<Record<string, unknown>> = [];
  const historyInserts: Array<Record<string, unknown>> = [];
  const tableReads: string[] = [];

  const client = {
    from(table: string) {
      if (table === 'workflow_shares') {
        return {
          select() {
            const query = {
              eq() {
                return query;
              },
              async maybeSingle() {
                tableReads.push(table);
                return {
                  data: options?.shareMissing ? null : shareRow,
                  error: null,
                };
              },
            };

            return query;
          },
        };
      }

      if (table === 'workflow_canvases') {
        return {
          insert(payload: Record<string, unknown>) {
            insertedCanvases.push(payload);
            return {
              select(columns?: string) {
                return {
                  async single() {
                    if (options?.fallbackInsert && 'status' in payload) {
                      return { data: null, error: lifecycleColumnError() };
                    }

                    return {
                      data: {
                        id: 'canvas-2',
                        title: String(payload.title),
                        graph: payload.graph,
                        created_at: '2026-04-02T10:05:00.000Z',
                        updated_at: '2026-04-02T10:05:00.000Z',
                        revision: 0,
                        ...(columns?.includes('status') ? { status: 'draft', published_at: null } : {}),
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
            return {
              error: options?.historyMissing ? historyTableMissingError() : null,
            };
          },
        };
      }

      throw new Error(`Unexpected user table: ${table}`);
    },
  };

  return {
    client: client as unknown as SupabaseClient,
    historyInserts,
    insertedCanvases,
    tableReads,
  };
}

function createServiceSupabaseMock({ allowed = true } = {}) {
  const importCountUpdates: Array<Record<string, unknown>> = [];
  const rpc = vi.fn(async () => ({
    data: {
      allowed,
      limit: 240,
      remaining: allowed ? 239 : 0,
      retryAfterSeconds: allowed ? 0 : 41,
      resetAt: '2026-06-22T06:30:00.000Z',
    },
    error: null,
  }));

  const client = {
    rpc,
    from(table: string) {
      if (table !== 'workflow_shares') {
        throw new Error(`Unexpected service table: ${table}`);
      }

      return {
        update(payload: Record<string, unknown>) {
          importCountUpdates.push(payload);
          return {
            async eq() {
              return { error: null };
            },
          };
        },
      };
    },
  };

  return {
    client: client as unknown as SupabaseClient,
    importCountUpdates,
    rpc,
  };
}

describe('importWorkflowShareForRoute', () => {
  it('rejects invalid share ids before rate-limit and table work', async () => {
    const userSupabase = createUserSupabaseMock();
    const serviceSupabase = createServiceSupabaseMock();

    const result = await importWorkflowShareForRoute({
      origin: 'http://localhost',
      serviceSupabase: serviceSupabase.client,
      shareId: 'not-a-share-id',
      userId: 'user-2',
      userSupabase: userSupabase.client,
    });

    expect(result).toEqual({
      ok: false,
      status: 404,
      body: { error: 'Workflow share not found.' },
    });
    expect(serviceSupabase.rpc).not.toHaveBeenCalled();
    expect(serviceSupabase.importCountUpdates).toEqual([]);
    expect(userSupabase.tableReads).toEqual([]);
  });

  it('rate limits imports before share lookup, canvas creation, or count updates', async () => {
    const userSupabase = createUserSupabaseMock();
    const serviceSupabase = createServiceSupabaseMock({ allowed: false });

    const result = await importWorkflowShareForRoute({
      origin: 'http://localhost',
      serviceSupabase: serviceSupabase.client,
      shareId: SHARE_ID,
      userId: 'user-2',
      userSupabase: userSupabase.client,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 429,
      body: {
        code: 'RATE_LIMITED',
        retryAfterSeconds: 41,
      },
    });
    expect(serviceSupabase.rpc).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'workflow-canvas:mutate',
      p_subject_key: 'user-2',
      p_limit: 240,
      p_window_seconds: 600,
    });
    expect(userSupabase.tableReads).toEqual([]);
    expect(userSupabase.insertedCanvases).toEqual([]);
    expect(serviceSupabase.importCountUpdates).toEqual([]);
  });

  it('imports shared workflow snapshots into draft canvases with legacy/history fallbacks', async () => {
    const userSupabase = createUserSupabaseMock({
      fallbackInsert: true,
      historyMissing: true,
    });
    const serviceSupabase = createServiceSupabaseMock();

    const result = await importWorkflowShareForRoute({
      origin: 'http://localhost',
      serviceSupabase: serviceSupabase.client,
      shareId: SHARE_ID,
      userId: 'user-2',
      userSupabase: userSupabase.client,
    });

    expect(result).toMatchObject({
      ok: true,
      body: {
        canvas: {
          id: 'canvas-2',
          title: 'Copy of Shared workflow',
          status: 'draft',
          published_at: null,
        },
        share: {
          id: SHARE_ID,
          importCount: 3,
          importPath: `/create-workflow?import=${SHARE_ID}`,
          importUrl: `http://localhost/create-workflow?import=${SHARE_ID}`,
        },
      },
    });
    expect(userSupabase.insertedCanvases).toHaveLength(2);
    expect(userSupabase.insertedCanvases[0]).toHaveProperty('status', 'draft');
    expect(userSupabase.insertedCanvases[1]).not.toHaveProperty('status');
    expect(userSupabase.historyInserts[0]).toMatchObject({
      canvas_id: 'canvas-2',
      user_id: 'user-2',
      title: 'Copy of Shared workflow',
      revision: 0,
      kind: 'draft',
    });
    expect(serviceSupabase.importCountUpdates).toEqual([{ import_count: 3 }]);
  });
});
