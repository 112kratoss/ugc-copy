import { describe, expect, it, vi } from 'vitest';

import { expectOk } from '@/__tests__/fixtures/route-result';
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

    const ok = expectOk(result);
    expect(ok.body.canvas).toMatchObject({
      id: 'canvas-1',
      title: 'Legacy workflow',
      revision: 2,
      status: 'draft',
      published_at: null,
    });
    expect(ok.body.canvas.graph.nodes).toEqual([]);
    expect(ok.body.canvas.graph.edges).toEqual([]);
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

describe('the uploads a deleted canvas named', () => {
  const UPLOAD = 'generated_images/user-1/workflow-input-11111111-1111-4111-8111-111111111111-cat.png';
  const SECOND_UPLOAD = 'generated_videos/user-1/workflow-input-22222222-2222-4222-8222-222222222222-walk.mp4';
  const SHOWN_OUTPUT = 'generated_images/user-1/generated_p9.png';

  function canvasNaming(paths: string[]): CanvasRow {
    const graph = createStarterGraph();
    return {
      id: 'canvas-1',
      user_id: 'user-1',
      title: 'Workflow to delete',
      graph: {
        ...graph,
        nodes: [
          ...graph.nodes,
          ...paths.map((storagePath, index) => {
            const node = createWorkflowNode(storagePath.includes('generated_videos') ? 'video-input' : 'image-input', { x: index * 100, y: 400 });
            return { ...node, data: { ...node.data, storagePath } } as typeof node;
          }),
        ],
      },
      created_at: '2026-06-22T10:00:00.000Z',
      updated_at: '2026-06-22T10:00:00.000Z',
      revision: 2,
    };
  }

  /** The service client the cleanup reads and removes with, answering from fixed rows. */
  function createCleanupClient({
    otherCanvases = [] as Array<{ id: string; graph: unknown }>,
    runSteps = [] as Array<{ generation_id: string | null }>,
    generations = [] as Array<{ id: string; status: string; workflow_settings: unknown }>,
    inputMedia = [] as Array<{ generation_id: string; metadata: Record<string, unknown> | null }>,
    legacy = [] as Array<{ id: string; user_id: string; workflow_settings: unknown }>,
    failingTable = null as string | null,
    legacyError = null as { message: string } | null,
  } = {}) {
    const removals: Array<{ bucket: string; paths: string[] }> = [];
    const reads: string[] = [];
    const rowsFor: Record<string, unknown[]> = {
      workflow_canvas_runs: [{ id: 'run-1' }],
      workflow_canvas_run_steps: runSteps,
      workflow_canvases: otherCanvases,
      generations,
      generation_input_media: inputMedia,
    };
    const client = {
      from(table: string) {
        reads.push(table);
        const query = {
          select: () => query,
          eq: () => query,
          in: () => query,
          then(resolve: (value: { data: unknown; error: unknown }) => unknown) {
            if (failingTable === table) return Promise.resolve({ data: null, error: { message: `${table} unavailable` } }).then(resolve);
            return Promise.resolve({ data: rowsFor[table] ?? [], error: null }).then(resolve);
          },
        };
        return query;
      },
      rpc: vi.fn(async () => (legacyError ? { data: null, error: legacyError } : { data: legacy, error: null })),
      storage: {
        from: (bucket: string) => ({
          remove: async (paths: string[]) => {
            removals.push({ bucket, paths });
            return { data: [], error: null };
          },
        }),
      },
    };
    return { client: client as unknown as SupabaseClient, removals, reads };
  }

  async function deleteCanvas(canvas: CanvasRow, cleanup: ReturnType<typeof createCleanupClient>, options: { failDelete?: boolean } = {}) {
    const supabase = createSupabaseMock(canvas);
    if (options.failDelete) supabase.failDelete({ message: 'database unavailable' });
    return deleteWorkflowCanvasForRoute({
      canvasId: 'canvas-1',
      supabase: supabase.client,
      userId: 'user-1',
      createCleanupClient: () => cleanup.client,
    });
  }

  it('go when nothing else names them, and a creation the canvas showed stays', async () => {
    const cleanup = createCleanupClient();

    const result = await deleteCanvas(canvasNaming([UPLOAD, SECOND_UPLOAD, SHOWN_OUTPUT]), cleanup);

    expect(result).toEqual({ ok: true, body: { success: true } });
    expect(cleanup.removals).toEqual([
      { bucket: 'generated_images', paths: ['user-1/workflow-input-11111111-1111-4111-8111-111111111111-cat.png'] },
      { bucket: 'generated_videos', paths: ['user-1/workflow-input-22222222-2222-4222-8222-222222222222-walk.mp4'] },
    ]);
  });

  it('stay while another canvas of the account names them', async () => {
    const cleanup = createCleanupClient({ otherCanvases: [{ id: 'canvas-2', graph: canvasNaming([UPLOAD]).graph }] });

    await deleteCanvas(canvasNaming([UPLOAD, SECOND_UPLOAD]), cleanup);

    expect(cleanup.removals).toEqual([
      { bucket: 'generated_videos', paths: ['user-1/workflow-input-22222222-2222-4222-8222-222222222222-walk.mp4'] },
    ]);
  });

  it('stay while a finished creation of its runs reads one it holds no copy of', async () => {
    const cleanup = createCleanupClient({
      runSteps: [{ generation_id: 'gen-1' }, { generation_id: null }],
      generations: [{ id: 'gen-1', status: 'succeeded', workflow_settings: { references: [{ storagePath: UPLOAD }] } }],
      inputMedia: [],
    });

    await deleteCanvas(canvasNaming([UPLOAD]), cleanup);

    expect(cleanup.removals).toEqual([]);
  });

  it('go once each finished creation that read them keeps its own copy', async () => {
    const cleanup = createCleanupClient({
      runSteps: [{ generation_id: 'gen-1' }],
      generations: [{ id: 'gen-1', status: 'succeeded', workflow_settings: { references: [{ storagePath: UPLOAD }] } }],
      inputMedia: [{ generation_id: 'gen-1', metadata: { sourceStoragePath: UPLOAD } }],
    });

    await deleteCanvas(canvasNaming([UPLOAD]), cleanup);

    expect(cleanup.removals).toEqual([
      { bucket: 'generated_images', paths: ['user-1/workflow-input-11111111-1111-4111-8111-111111111111-cat.png'] },
    ]);
  });

  it('stay while a creation that reads them is still rendering', async () => {
    const cleanup = createCleanupClient({
      runSteps: [{ generation_id: 'gen-1' }],
      generations: [{ id: 'gen-1', status: 'processing', workflow_settings: { references: [{ storagePath: UPLOAD }] } }],
      inputMedia: [{ generation_id: 'gen-1', metadata: { sourceStoragePath: UPLOAD } }],
    });

    await deleteCanvas(canvasNaming([UPLOAD]), cleanup);

    expect(cleanup.removals).toEqual([]);
  });

  it('stay while a creation with no kept inputs names them', async () => {
    const cleanup = createCleanupClient({
      legacy: [{ id: 'gen-old', user_id: 'user-1', workflow_settings: { imageUrls: [UPLOAD] } }],
    });

    await deleteCanvas(canvasNaming([UPLOAD]), cleanup);

    expect(cleanup.removals).toEqual([]);
  });

  it.each([
    'workflow_canvas_runs',
    'workflow_canvas_run_steps',
    'workflow_canvases',
    'generations',
    'generation_input_media',
  ])('stay when %s cannot be read', async (failingTable) => {
    const cleanup = createCleanupClient({
      failingTable,
      runSteps: [{ generation_id: 'gen-1' }],
      generations: [{ id: 'gen-1', status: 'succeeded', workflow_settings: { references: [{ storagePath: UPLOAD }] } }],
      inputMedia: [{ generation_id: 'gen-1', metadata: { sourceStoragePath: UPLOAD } }],
    });

    const result = await deleteCanvas(canvasNaming([UPLOAD]), cleanup);

    expect(result).toEqual({ ok: true, body: { success: true } });
    expect(cleanup.removals).toEqual([]);
  });

  it('stay when the scan of creations with no kept inputs fails or may be cut short', async () => {
    for (const cleanup of [
      createCleanupClient({ legacyError: { message: 'rpc unavailable' } }),
      createCleanupClient({ legacy: Array.from({ length: 1000 }, (_, index) => ({ id: `gen-${index}`, user_id: 'user-2', workflow_settings: {} })) }),
    ]) {
      await deleteCanvas(canvasNaming([UPLOAD]), cleanup);
      expect(cleanup.removals).toEqual([]);
    }
  });

  it('stay when the canvas is not deleted', async () => {
    const cleanup = createCleanupClient();

    await expect(deleteCanvas(canvasNaming([UPLOAD]), cleanup, { failDelete: true }))
      .resolves.toMatchObject({ ok: false, status: 500 });
    expect(cleanup.removals).toEqual([]);
  });

  it('reads nothing more for a canvas that names no upload', async () => {
    const cleanup = createCleanupClient();

    await deleteCanvas(canvasNaming([SHOWN_OUTPUT]), cleanup);

    expect(cleanup.reads).toEqual([]);
    expect(cleanup.removals).toEqual([]);
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

    const ok = expectOk(result);
    expect(ok.body.canvas.title).toBe('Edited workflow');
    expect(ok.body.canvas.status).toBe('draft');
    expect(ok.body.canvas.revision).toBe(5);
    expect(ok.body.canvas.graph.nodes[0].data.title).toBe('Edited node');
    expect(ok.body.canvas.graph.nodes[0].data.runState).toMatchObject({
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
