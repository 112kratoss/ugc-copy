import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  createNodeRunState,
  createStarterGraph,
  createWorkflowNode,
  type WorkflowCanvasGraph,
} from '@/lib/workflow-canvas';
import {
  deleteWorkflowCanvasForRoute,
  getWorkflowCanvasForRoute,
  patchWorkflowCanvasForRoute,
} from '@/lib/workflow-canvas-route-service';

type CanvasRow = {
  id: string;
  user_id: string;
  title: string;
  graph: WorkflowCanvasGraph;
  created_at: string;
  updated_at: string;
  revision: number;
  status?: string | null;
  published_at?: string | null;
};

function makeSingleCanvasQuery(canvas: () => CanvasRow | null) {
  const query = {
    eq() {
      return query;
    },
    async single() {
      return {
        data: canvas(),
        error: null,
      };
    },
  };
  return query;
}

function createSupabaseMock(initialCanvas: CanvasRow) {
  let canvasState = initialCanvas;
  let failNextLifecycleSelect = false;
  let deleteError: unknown = null;
  const deletes: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const historyInserts: Array<Record<string, unknown>> = [];

  const client = {
    from(table: string) {
      if (table === 'workflow_canvases') {
        return {
          select(columns?: string) {
            if (failNextLifecycleSelect && String(columns).includes('status')) {
              failNextLifecycleSelect = false;
              const query = {
                eq() {
                  return query;
                },
                async single() {
                  return {
                    data: null,
                    error: {
                      code: 'PGRST204',
                      message: "Could not find the 'status' column of 'workflow_canvases' in the schema cache",
                    },
                  };
                },
              };
              return query;
            }

            return makeSingleCanvasQuery(() => ({ ...canvasState }));
          },
          delete() {
            const filters: Record<string, unknown> = {};
            const query = {
              eq(column: string, value: unknown) {
                filters[column] = value;
                return query;
              },
              then(resolve: (value: { error: unknown }) => void) {
                deletes.push(filters);
                if (!deleteError && filters.id === canvasState.id && filters.user_id === canvasState.user_id) {
                  canvasState = null as unknown as CanvasRow;
                }
                resolve({ error: deleteError });
              },
            };
            return query;
          },
          update(payload: Record<string, unknown>) {
            const filters: Record<string, unknown> = {};
            const query = {
              eq(column: string, value: unknown) {
                filters[column] = value;
                return query;
              },
              select() {
                return query;
              },
              async maybeSingle() {
                updates.push(payload);
                if (filters.id !== canvasState.id || filters.user_id !== canvasState.user_id) {
                  return { data: null, error: null };
                }

                canvasState = {
                  ...canvasState,
                  title: String(payload.title),
                  graph: payload.graph as WorkflowCanvasGraph,
                  revision: Number(payload.revision),
                  status: typeof payload.status === 'string' ? payload.status : canvasState.status,
                  updated_at: '2026-06-22T10:05:00.000Z',
                };

                return {
                  data: { ...canvasState },
                  error: null,
                };
              },
            };
            return query;
          },
        };
      }

      if (table === 'workflow_canvas_history') {
        return {
          async insert(payload: Record<string, unknown>) {
            historyInserts.push(payload);
            return { error: null };
          },
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    },
  };

  return {
    client: client as unknown as SupabaseClient,
    get canvas() {
      return canvasState;
    },
    deletes,
    historyInserts,
    updates,
    failNextLifecycleSelect() {
      failNextLifecycleSelect = true;
    },
    failDelete(error: unknown) {
      deleteError = error;
    },
  };
}

describe('getWorkflowCanvasForRoute', () => {
  it('falls back to the legacy select shape and returns lifecycle defaults', async () => {
    const supabase = createSupabaseMock({
      id: 'canvas-1',
      user_id: 'user-1',
      title: 'Legacy workflow',
      graph: {
        version: 1,
        nodes: [],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      },
      created_at: '2026-06-22T10:00:00.000Z',
      updated_at: '2026-06-22T10:00:00.000Z',
      revision: 2,
    });
    supabase.failNextLifecycleSelect();

    const result = await getWorkflowCanvasForRoute({
      canvasId: 'canvas-1',
      supabase: supabase.client,
      userId: 'user-1',
    });

    expect(result.ok).toBe(true);
    expect(result.body.canvas).toMatchObject({
      id: 'canvas-1',
      title: 'Legacy workflow',
      revision: 2,
      status: 'draft',
      published_at: null,
    });
    expect(result.body.canvas.graph.nodes).toEqual([]);
    expect(result.body.canvas.graph.edges).toEqual([]);
  });
});

describe('deleteWorkflowCanvasForRoute', () => {
  it('deletes only the authenticated user owned canvas', async () => {
    const supabase = createSupabaseMock({
      id: 'canvas-1',
      user_id: 'user-1',
      title: 'Workflow to delete',
      graph: createStarterGraph(),
      created_at: '2026-06-22T10:00:00.000Z',
      updated_at: '2026-06-22T10:00:00.000Z',
      revision: 2,
    });

    const result = await deleteWorkflowCanvasForRoute({
      canvasId: 'canvas-1',
      supabase: supabase.client,
      userId: 'user-1',
    });

    expect(result).toEqual({ ok: true, body: { success: true } });
    expect(supabase.deletes).toEqual([
      {
        id: 'canvas-1',
        user_id: 'user-1',
      },
    ]);
  });

  it('maps Supabase delete failures to the stable route error', async () => {
    const supabase = createSupabaseMock({
      id: 'canvas-1',
      user_id: 'user-1',
      title: 'Workflow to delete',
      graph: createStarterGraph(),
      created_at: '2026-06-22T10:00:00.000Z',
      updated_at: '2026-06-22T10:00:00.000Z',
      revision: 2,
    });
    supabase.failDelete({ message: 'database unavailable' });

    const result = await deleteWorkflowCanvasForRoute({
      canvasId: 'canvas-1',
      supabase: supabase.client,
      userId: 'user-1',
    });

    expect(result).toEqual({
      ok: false,
      status: 500,
      body: { error: 'Failed to delete workflow canvas.' },
    });
  });
});

describe('patchWorkflowCanvasForRoute', () => {
  it('saves a published canvas as a draft while preserving stored run state and writing history', async () => {
    const runnableNode = createWorkflowNode('image-generate', { x: 320, y: 0 });
    const storedGraph = {
      ...createStarterGraph(),
      nodes: [
        {
          ...runnableNode,
          data: {
            ...runnableNode.data,
            title: 'Original node',
            runState: createNodeRunState({
              status: 'succeeded',
              generationId: 'gen-123',
              outputUrl: 'https://example.com/output.jpg',
            }),
          },
        },
      ],
      edges: [],
    };
    const supabase = createSupabaseMock({
      id: 'canvas-1',
      user_id: 'user-1',
      title: 'Published workflow',
      graph: storedGraph,
      created_at: '2026-06-22T10:00:00.000Z',
      updated_at: '2026-06-22T10:00:00.000Z',
      revision: 4,
      status: 'published',
      published_at: '2026-06-22T10:01:00.000Z',
    });
    const incomingGraph = {
      ...storedGraph,
      nodes: storedGraph.nodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          title: 'Edited node',
          runState: createNodeRunState({ status: 'failed' }),
        },
      })),
    };

    const result = await patchWorkflowCanvasForRoute({
      body: {
        title: 'Edited workflow',
        graph: incomingGraph,
        baseRevision: 4,
      },
      canvasId: 'canvas-1',
      supabase: supabase.client,
      userId: 'user-1',
    });

    expect(result.ok).toBe(true);
    expect(result.body.canvas.title).toBe('Edited workflow');
    expect(result.body.canvas.status).toBe('draft');
    expect(result.body.canvas.revision).toBe(5);
    expect(result.body.canvas.graph.nodes[0].data.title).toBe('Edited node');
    expect(result.body.canvas.graph.nodes[0].data.runState).toMatchObject({
      status: 'succeeded',
      generationId: 'gen-123',
      outputUrl: 'https://example.com/output.jpg',
    });
    expect(supabase.updates[0]).toMatchObject({
      title: 'Edited workflow',
      revision: 5,
      status: 'draft',
    });
    expect(supabase.historyInserts[0]).toMatchObject({
      canvas_id: 'canvas-1',
      user_id: 'user-1',
      title: 'Edited workflow',
      revision: 5,
      kind: 'draft',
    });
  });
});
