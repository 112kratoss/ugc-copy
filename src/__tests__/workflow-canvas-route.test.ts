import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createStarterGraph, createWorkflowGraphHash } from '@/lib/workflow-canvas';

type CanvasRow = {
  id: string;
  user_id: string;
  title: string;
  graph: ReturnType<typeof createStarterGraph>;
  created_at: string;
  updated_at: string;
  revision: number;
};

let canvasState: CanvasRow;
let forceConditionalUpdateRace = false;
let updateCalls = 0;

function createSupabaseMock() {
  return {
    from(table: string) {
      if (table !== 'workflow_canvases') {
        throw new Error(`Unexpected table: ${table}`);
      }

      return {
        select() {
          const filters: Record<string, unknown> = {};

          const query = {
            eq(column: string, value: unknown) {
              filters[column] = value;
              return query;
            },
            async single() {
              if (
                filters.id === canvasState.id &&
                filters.user_id === canvasState.user_id
              ) {
                return { data: { ...canvasState }, error: null };
              }

              return { data: null, error: { message: 'Missing canvas' } };
            },
          };

          return query;
        },
        update(values: Record<string, unknown>) {
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
              updateCalls += 1;

              if (forceConditionalUpdateRace && typeof filters.revision === 'number') {
                canvasState = {
                  ...canvasState,
                  title: 'Server version',
                  revision: canvasState.revision + 1,
                  updated_at: '2026-03-24T11:05:00.000Z',
                };
                forceConditionalUpdateRace = false;
                return { data: null, error: null };
              }

              const matchesCanvas =
                filters.id === canvasState.id &&
                filters.user_id === canvasState.user_id &&
                (filters.revision === undefined || filters.revision === canvasState.revision);

              if (!matchesCanvas) {
                return { data: null, error: null };
              }

              canvasState = {
                ...canvasState,
                title: String(values.title ?? canvasState.title),
                graph: (values.graph as CanvasRow['graph']) ?? canvasState.graph,
                revision: Number(values.revision ?? canvasState.revision),
                updated_at: '2026-03-24T11:01:00.000Z',
              };

              return { data: { ...canvasState }, error: null };
            },
          };

          return query;
        },
      };
    },
  };
}

const authenticateRequestMock = vi.fn(async () => ({
  userId: 'user-1',
  supabase: createSupabaseMock(),
}));

vi.mock('@/lib/server-helpers', () => ({
  authenticateRequest: (..._args: unknown[]) => authenticateRequestMock(),
}));

describe('/api/workflow-canvases/[id] PATCH', () => {
  beforeEach(() => {
    vi.resetModules();
    canvasState = {
      id: 'canvas-1',
      user_id: 'user-1',
      title: 'Workflow canvas',
      graph: createStarterGraph(),
      created_at: '2026-03-24T11:00:00.000Z',
      updated_at: '2026-03-24T11:00:00.000Z',
      revision: 2,
    };
    forceConditionalUpdateRace = false;
    updateCalls = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 409 with the latest canvas when the request revision is stale', async () => {
    const { PATCH } = await import('@/app/api/workflow-canvases/[id]/route');
    const response = await PATCH(
      new Request('http://localhost/api/workflow-canvases/canvas-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Older draft',
          graph: canvasState.graph,
          baseRevision: 1,
        }),
      }) as never,
      { params: Promise.resolve({ id: 'canvas-1' }) }
    );

    const data = await response.json();
    expect(response.status).toBe(409);
    expect(data.canvas.revision).toBe(2);
    expect(updateCalls).toBe(0);
  });

  it('returns 409 instead of 500 when a conditional update loses a race', async () => {
    forceConditionalUpdateRace = true;

    const { PATCH } = await import('@/app/api/workflow-canvases/[id]/route');
    const response = await PATCH(
      new Request('http://localhost/api/workflow-canvases/canvas-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Local draft',
          graph: canvasState.graph,
          baseRevision: 2,
        }),
      }) as never,
      { params: Promise.resolve({ id: 'canvas-1' }) }
    );

    const data = await response.json();
    expect(response.status).toBe(409);
    expect(data.canvas.title).toBe('Server version');
    expect(data.canvas.revision).toBe(3);
  });

  it('returns 200 for a no-op save without issuing an update', async () => {
    const currentGraphHash = createWorkflowGraphHash(canvasState.graph);
    const { PATCH } = await import('@/app/api/workflow-canvases/[id]/route');
    const response = await PATCH(
      new Request('http://localhost/api/workflow-canvases/canvas-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: canvasState.title,
          graph: canvasState.graph,
          baseRevision: canvasState.revision,
          graphHash: currentGraphHash,
        }),
      }) as never,
      { params: Promise.resolve({ id: 'canvas-1' }) }
    );

    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.canvas.revision).toBe(2);
    expect(updateCalls).toBe(0);
  });
});
