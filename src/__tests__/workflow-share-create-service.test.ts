import { describe, expect, it, vi } from 'vitest';

import { createWorkflowShareForRoute } from '@/lib/workflow-share-create-service';
import {
  createStarterGraph,
  createWorkflowNode,
  createWorkflowShareSnapshotGraph,
  type SerializedWorkflowCanvasGraph,
  type WorkflowCanvasGraph,
  type WorkflowNodeKind,
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
  /** The canvas's stored graph; the starter graph without one. */
  graph?: WorkflowCanvasGraph;
}) {
  const selectedCanvasColumns: string[] = [];
  const tableReads: string[] = [];

  const canvasRow = {
    id: 'canvas-1',
    title: 'Workflow canvas',
    graph: options?.graph ?? sourceGraph,
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

  // 2026-11-04 re-review: a share kept each input's prepared Seedance asset id, which runs the file it was
  // prepared from for anyone who imports the share, the link it was prepared from aside. One a buyer
  // prepared from a file of someone else's recipe ran the seller's picture for strangers: it is left out,
  // its input empty for the importer to fill. The sharer's own assets go with the share, as before.
  it('leaves out of a share an asset prepared from a recipe file, and shares the sharer’s own', async () => {
    const signed = (path: string) => `https://project.supabase.co/storage/v1/object/sign/${path}?token=read`;
    const prepared = (type: WorkflowNodeKind, id: string, assetId: string, assetType: string, sourcePath: string) => {
      const node = createWorkflowNode(type, { x: 0, y: 0 });
      node.id = id;
      Object.assign(node.data, {
        seedanceAsset: { assetId, assetType, status: 'active', sourceUrl: signed(sourcePath), error: null, lastCheckedAt: '2026-11-04T09:00:00.000Z' },
      });
      return node;
    };
    const graph: WorkflowCanvasGraph = {
      ...createStarterGraph(),
      nodes: [
        // As the asset route answers a recipe file: prepared from the buyer's import of the seller's copy.
        prepared('image-input', 'bought-import', 'asset-import', 'Image', 'generation_inputs/user-1/recipe-imports/seller-9/gen-0/00-reference-image-row-9.png'),
        prepared('video-input', 'bought-copy', 'asset-copy', 'Video', 'post_resource_files/seller-9/generation-references/gen-0/01-reference-video-row-8.mp4'),
        // An import in the first round's layout, which named no seller.
        prepared('audio-input', 'bought-first-round', 'asset-first-round', 'Audio', 'generation_inputs/user-1/recipe-imports/gen-0/02-reference-audio-row-7.mp3'),
        prepared('image-input', 'own-upload', 'asset-own', 'Image', 'generated_images/user-1/face.png'),
        // The sharer's own recipe's copy of their own creation's input is their own file.
        prepared('image-input', 'own-recipe-copy', 'asset-own-copy', 'Image', 'post_resource_files/user-1/generation-references/gen-1/00-reference-image-row-1.png'),
      ],
      edges: [],
    };
    const serviceSupabase = createServiceSupabaseMock();

    const result = await createWorkflowShareForRoute({
      canvasId: 'canvas-1',
      origin: 'http://localhost',
      serviceSupabase: serviceSupabase.client,
      userId: 'user-1',
      userSupabase: createUserSupabaseMock({ graph }).client,
    });

    expect(result).toMatchObject({ ok: true });
    const shared = serviceSupabase.insertedShares[0].graph as SerializedWorkflowCanvasGraph;
    const assetOf = (id: string) => (shared.nodes.find((node) => node.id === id)?.data as { seedanceAsset?: unknown }).seedanceAsset;
    for (const id of ['bought-import', 'bought-copy', 'bought-first-round']) {
      expect(assetOf(id), id).toMatchObject({ assetId: null, status: 'idle', sourceUrl: null, lastCheckedAt: null });
    }
    expect(assetOf('own-upload')).toMatchObject({ assetId: 'asset-own', assetType: 'Image', status: 'active', sourceUrl: null });
    expect(assetOf('own-recipe-copy')).toMatchObject({ assetId: 'asset-own-copy', status: 'active', sourceUrl: null });
    expect(JSON.stringify(shared)).not.toMatch(/asset-import|asset-copy|asset-first-round|seller-9|recipe-imports|post_resource_files/);
  });
});
