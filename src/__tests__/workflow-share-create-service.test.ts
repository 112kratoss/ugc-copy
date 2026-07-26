import { describe, expect, it, vi } from 'vitest';

import { createWorkflowShareForRoute } from '@/lib/workflow-share-create-service';
import {
  createStarterGraph,
  createWorkflowShareSnapshotGraph,
} from '@/lib/workflow-canvas';
import {
  WORKFLOW_CANVAS_SELECT,
  WORKFLOW_CANVAS_SELECT_LEGACY,
} from '@/lib/workflow-canvas-route-compat';
import { WORKFLOW_SHARE_SUMMARY_SELECT } from '@/lib/workflow-share';

const SHARE_ID = '11111111-1111-4111-8111-111111111111';
const sourceGraph = createStarterGraph();

function lifecycleColumnError() {
  return { code: '42703', message: 'column workflow_canvases.status does not exist' };
}

function createServiceSupabaseMock({
  allowed = true,
  shareInsertError = false,
}: {
  allowed?: boolean;
  shareInsertError?: boolean;
} = {}) {
  const insertedShares: Array<Record<string, unknown>> = [];
  const tableReads: string[] = [];
  const rpc = vi.fn(async () => ({
    data: {
      allowed,
      limit: 240,
      remaining: allowed ? 239 : 0,
      retryAfterSeconds: allowed ? 0 : 41,
      resetAt: '2026-06-23T06:30:00.000Z',
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
        insert(payload: Record<string, unknown>) {
          insertedShares.push(payload);
          return {
            select(columns: string) {
              return {
                async single() {
                  tableReads.push(table);
                  if (shareInsertError) {
                    return { data: null, error: { message: 'insert failed' } };
                  }

                  return {
                    data: {
                      id: SHARE_ID,
                      title: String(payload.title),
                      node_count: Number(payload.node_count ?? 0),
                      edge_count: Number(payload.edge_count ?? 0),
                      import_count: 0,
                      created_at: '2026-04-02T10:00:00.000Z',
                      selectedColumns: columns,
                    },
                    error: null,
                  };
                },
              };
            },
          };
        },
      };
    },
  };

  return {
    client,
    insertedShares,
    rpc,
    tableReads,
  };
}

function createUserSupabaseMock(options?: {
  canvasMissing?: boolean;
  fallbackCanvasLoad?: boolean;
}) {
  const selectedCanvasColumns: string[] = [];
  const tableReads: string[] = [];

  const canvasRow = {
    id: 'canvas-1',
    title: 'Workflow canvas',
    graph: sourceGraph,
    created_at: '2026-04-02T09:00:00.000Z',
    updated_at: '2026-04-02T09:00:00.000Z',
    revision: 3,
    status: 'draft',
    published_at: null,
  };

  const client = {
    from(table: string) {
      if (table === 'workflow_canvases') {
        return {
          select(columns: string) {
            selectedCanvasColumns.push(columns);
            const query = {
              eq() {
                return query;
              },
              async single() {
                tableReads.push(table);
                if (options?.fallbackCanvasLoad && columns === WORKFLOW_CANVAS_SELECT) {
                  return { data: null, error: lifecycleColumnError() };
                }

                return options?.canvasMissing
                  ? { data: null, error: { message: 'not found' } }
                  : { data: canvasRow, error: null };
              },
            };

            return query;
          },
        };
      }

      throw new Error(`Unexpected user table: ${table}`);
    },
  };

  return {
    client,
    selectedCanvasColumns,
    tableReads,
  };
}

describe('createWorkflowShareForRoute', () => {
  it('rate limits share creation before canvas lookup or share insert', async () => {
    const userSupabase = createUserSupabaseMock();
    const serviceSupabase = createServiceSupabaseMock({ allowed: false });

    const result = await createWorkflowShareForRoute({
      canvasId: 'canvas-1',
      origin: 'http://localhost',
      serviceSupabase: serviceSupabase.client,
      userId: 'user-1',
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
      p_subject_key: 'user-1',
      p_limit: 240,
      p_window_seconds: 600,
    });
    expect(userSupabase.tableReads).toEqual([]);
    expect(serviceSupabase.insertedShares).toEqual([]);
  });

  it('loads owner canvases with legacy lifecycle fallback before creating share snapshots', async () => {
    const userSupabase = createUserSupabaseMock({ fallbackCanvasLoad: true });
    const serviceSupabase = createServiceSupabaseMock();
    const sharedGraph = createWorkflowShareSnapshotGraph(sourceGraph);

    const result = await createWorkflowShareForRoute({
      canvasId: 'canvas-1',
      origin: 'http://localhost',
      serviceSupabase: serviceSupabase.client,
      userId: 'user-1',
      userSupabase: userSupabase.client,
    });

    expect(result).toMatchObject({
      ok: true,
      body: {
        share: {
          id: SHARE_ID,
          title: 'Workflow canvas',
          nodeCount: sharedGraph.nodes.length,
          edgeCount: sharedGraph.edges.length,
          importPath: `/create-workflow?import=${SHARE_ID}`,
          importUrl: `http://localhost/create-workflow?import=${SHARE_ID}`,
        },
      },
    });
    expect(userSupabase.selectedCanvasColumns).toEqual([
      WORKFLOW_CANVAS_SELECT,
      WORKFLOW_CANVAS_SELECT_LEGACY,
    ]);
    expect(serviceSupabase.insertedShares[0]).toMatchObject({
      owner_user_id: 'user-1',
      source_canvas_id: 'canvas-1',
      source_revision: 3,
      title: 'Workflow canvas',
      graph: sharedGraph,
      node_count: sharedGraph.nodes.length,
      edge_count: sharedGraph.edges.length,
    });
  });

  it('returns not found when the authenticated owner cannot access the canvas', async () => {
    const userSupabase = createUserSupabaseMock({ canvasMissing: true });
    const serviceSupabase = createServiceSupabaseMock();

    const result = await createWorkflowShareForRoute({
      canvasId: 'canvas-1',
      origin: 'http://localhost',
      serviceSupabase: serviceSupabase.client,
      userId: 'user-1',
      userSupabase: userSupabase.client,
    });

    expect(result).toEqual({
      ok: false,
      status: 404,
      body: { error: 'Workflow canvas not found.' },
    });
    expect(serviceSupabase.insertedShares).toEqual([]);
  });

  it('maps share insert failures to stable route errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const userSupabase = createUserSupabaseMock();
    const serviceSupabase = createServiceSupabaseMock({ shareInsertError: true });

    const result = await createWorkflowShareForRoute({
      canvasId: 'canvas-1',
      origin: 'http://localhost',
      serviceSupabase: serviceSupabase.client,
      userId: 'user-1',
      userSupabase: userSupabase.client,
    });

    expect(result).toEqual({
      ok: false,
      status: 500,
      body: { error: 'Failed to create workflow share link.' },
    });
    expect(serviceSupabase.insertedShares[0]).toMatchObject({
      owner_user_id: 'user-1',
    });
  });

  it('uses the workflow share summary select list for response rows', async () => {
    const userSupabase = createUserSupabaseMock();
    const serviceSupabase = createServiceSupabaseMock();

    await createWorkflowShareForRoute({
      canvasId: 'canvas-1',
      origin: 'http://localhost',
      serviceSupabase: serviceSupabase.client,
      userId: 'user-1',
      userSupabase: userSupabase.client,
    });

    expect(serviceSupabase.tableReads).toContain('workflow_shares');
    expect(serviceSupabase.insertedShares).toHaveLength(1);
    expect(WORKFLOW_SHARE_SUMMARY_SELECT).toContain('import_count');
  });
});
