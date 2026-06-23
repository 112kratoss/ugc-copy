import { describe, expect, it, vi } from 'vitest';

import {
  listWorkflowCanvasHistoryForRoute,
  publishWorkflowCanvasForRoute,
  restoreWorkflowCanvasHistoryForRoute,
} from '@/lib/workflow-canvas-lifecycle-service';

type QueryResult = { data: unknown; error: unknown };

type QueryCall = {
  operation: 'select' | 'update';
  table: string;
  columns?: string;
  values?: Record<string, unknown>;
  filters: Array<[string, unknown]>;
  order?: [string, Record<string, unknown>];
  limit?: number;
};

const graph = {
  nodes: [],
  edges: [],
  viewport: { x: 12, y: 18, zoom: 0.9 },
};

function createQuery(result: QueryResult, call: QueryCall) {
  const query = {
    eq(column: string, value: unknown) {
      call.filters.push([column, value]);
      return query;
    },
    order(column: string, options: Record<string, unknown>) {
      call.order = [column, options];
      return query;
    },
    limit(value: number) {
      call.limit = value;
      return query;
    },
    select(columns: string) {
      call.columns = columns;
      return query;
    },
    single: vi.fn(async () => result),
    then<TResult1 = QueryResult, TResult2 = never>(
      onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) {
      return Promise.resolve(result).then(onfulfilled, onrejected);
    },
  };
  return query;
}

function createSupabase({
  insertErrors = {},
  selectResults = {},
  updateResults = {},
}: {
  insertErrors?: Record<string, unknown[]>;
  selectResults?: Record<string, QueryResult[]>;
  updateResults?: Record<string, QueryResult[]>;
} = {}) {
  const queryCalls: QueryCall[] = [];
  const insertCalls: Array<{ table: string; values: Record<string, unknown> }> = [];

  function takeResult(source: Record<string, QueryResult[]>, table: string): QueryResult {
    return source[table]?.shift() ?? { data: null, error: null };
  }

  return {
    queryCalls,
    insertCalls,
    client: {
      from(table: string) {
        return {
          select(columns: string) {
            const call: QueryCall = {
              operation: 'select',
              table,
              columns,
              filters: [],
            };
            queryCalls.push(call);
            return createQuery(takeResult(selectResults, table), call);
          },
          update(values: Record<string, unknown>) {
            const call: QueryCall = {
              operation: 'update',
              table,
              values,
              filters: [],
            };
            queryCalls.push(call);
            return createQuery(takeResult(updateResults, table), call);
          },
          async insert(values: Record<string, unknown>) {
            insertCalls.push({ table, values });
            return { error: insertErrors[table]?.shift() ?? null };
          },
        };
      },
    },
  };
}

describe('workflow canvas lifecycle service', () => {
  it('lists the latest owner-scoped history entries with normalized graphs', async () => {
    const supabase = createSupabase({
      selectResults: {
        workflow_canvas_history: [{
          data: [{
            id: 'history-1',
            canvas_id: 'canvas-1',
            title: 'First snapshot',
            graph,
            revision: 3,
            kind: 'draft',
            created_at: '2026-06-22T10:00:00.000Z',
          }],
          error: null,
        }],
      },
    });

    await expect(listWorkflowCanvasHistoryForRoute({
      canvasId: 'canvas-1',
      supabase: supabase.client as never,
      userId: 'user-1',
    })).resolves.toMatchObject({
      ok: true,
      body: {
        history: [{
          id: 'history-1',
          graph: { nodes: [], edges: [], viewport: graph.viewport },
        }],
      },
    });

    expect(supabase.queryCalls[0]).toMatchObject({
      table: 'workflow_canvas_history',
      filters: [['canvas_id', 'canvas-1'], ['user_id', 'user-1']],
      order: ['created_at', { ascending: false }],
      limit: 30,
    });
  });

  it('maps history query failures to the stable route response', async () => {
    const supabase = createSupabase({
      selectResults: {
        workflow_canvas_history: [{ data: null, error: new Error('read failed') }],
      },
    });

    await expect(listWorkflowCanvasHistoryForRoute({
      canvasId: 'canvas-1',
      supabase: supabase.client as never,
      userId: 'user-1',
    })).resolves.toEqual({
      ok: false,
      status: 500,
      body: { error: 'Failed to fetch workflow history.' },
    });
  });

  it('publishes an owned canvas with a new revision and best-effort history snapshot', async () => {
    const currentCanvas = {
      id: 'canvas-1',
      title: 'Campaign flow',
      graph,
      created_at: '2026-06-22T09:00:00.000Z',
      updated_at: '2026-06-22T09:30:00.000Z',
      revision: 4,
      status: 'draft',
      published_at: null,
    };
    const publishedCanvas = {
      ...currentCanvas,
      revision: 5,
      status: 'published',
      published_at: '2026-06-23T00:00:00.000Z',
    };
    const supabase = createSupabase({
      selectResults: {
        workflow_canvases: [{ data: currentCanvas, error: null }],
      },
      updateResults: {
        workflow_canvases: [{ data: publishedCanvas, error: null }],
      },
    });

    await expect(publishWorkflowCanvasForRoute({
      canvasId: 'canvas-1',
      now: () => new Date('2026-06-23T00:00:00.000Z'),
      supabase: supabase.client as never,
      userId: 'user-1',
    })).resolves.toMatchObject({
      ok: true,
      body: { canvas: { revision: 5, status: 'published', graph } },
    });

    expect(supabase.queryCalls[1]).toMatchObject({
      operation: 'update',
      table: 'workflow_canvases',
      values: {
        status: 'published',
        published_at: '2026-06-23T00:00:00.000Z',
        revision: 5,
      },
      filters: [['id', 'canvas-1'], ['user_id', 'user-1']],
    });
    expect(supabase.insertCalls).toEqual([{
      table: 'workflow_canvas_history',
      values: {
        canvas_id: 'canvas-1',
        user_id: 'user-1',
        title: 'Campaign flow',
        graph,
        revision: 5,
        kind: 'published',
      },
    }]);
  });

  it('returns not found before publishing when the owner canvas is missing', async () => {
    const supabase = createSupabase({
      selectResults: {
        workflow_canvases: [{ data: null, error: new Error('missing') }],
      },
    });

    await expect(publishWorkflowCanvasForRoute({
      canvasId: 'canvas-1',
      supabase: supabase.client as never,
      userId: 'user-1',
    })).resolves.toEqual({
      ok: false,
      status: 404,
      body: { error: 'Workflow canvas not found.' },
    });

    expect(supabase.insertCalls).toEqual([]);
  });

  it('restores owner history into a draft revision and records the restored snapshot', async () => {
    const historyEntry = {
      id: 'history-1',
      canvas_id: 'canvas-1',
      title: 'Earlier campaign',
      graph,
      revision: 2,
      kind: 'draft',
      created_at: '2026-06-22T08:00:00.000Z',
    };
    const currentCanvas = {
      id: 'canvas-1',
      revision: 7,
      published_at: '2026-06-22T09:00:00.000Z',
    };
    const restoredCanvas = {
      id: 'canvas-1',
      title: historyEntry.title,
      graph,
      created_at: '2026-06-22T07:00:00.000Z',
      updated_at: '2026-06-23T00:00:00.000Z',
      revision: 8,
      status: 'draft',
      published_at: currentCanvas.published_at,
    };
    const supabase = createSupabase({
      selectResults: {
        workflow_canvas_history: [{ data: historyEntry, error: null }],
        workflow_canvases: [{ data: currentCanvas, error: null }],
      },
      updateResults: {
        workflow_canvases: [{ data: restoredCanvas, error: null }],
      },
    });

    await expect(restoreWorkflowCanvasHistoryForRoute({
      canvasId: 'canvas-1',
      entryId: 'history-1',
      supabase: supabase.client as never,
      userId: 'user-1',
    })).resolves.toMatchObject({
      ok: true,
      body: { canvas: { title: 'Earlier campaign', revision: 8, status: 'draft', graph } },
    });

    expect(supabase.queryCalls[0].filters).toEqual([
      ['id', 'history-1'],
      ['canvas_id', 'canvas-1'],
      ['user_id', 'user-1'],
    ]);
    expect(supabase.queryCalls[2]).toMatchObject({
      operation: 'update',
      values: {
        title: 'Earlier campaign',
        graph,
        viewport: graph.viewport,
        revision: 8,
        status: 'draft',
      },
      filters: [['id', 'canvas-1'], ['user_id', 'user-1']],
    });
    expect(supabase.insertCalls[0]).toMatchObject({
      table: 'workflow_canvas_history',
      values: { revision: 8, kind: 'draft' },
    });
  });

  it('returns history not found before loading the current canvas', async () => {
    const supabase = createSupabase({
      selectResults: {
        workflow_canvas_history: [{ data: null, error: new Error('missing') }],
      },
    });

    await expect(restoreWorkflowCanvasHistoryForRoute({
      canvasId: 'canvas-1',
      entryId: 'history-1',
      supabase: supabase.client as never,
      userId: 'user-1',
    })).resolves.toEqual({
      ok: false,
      status: 404,
      body: { error: 'Workflow history entry not found.' },
    });

    expect(supabase.queryCalls).toHaveLength(1);
  });

  it('maps restore update failures without creating a history snapshot', async () => {
    const supabase = createSupabase({
      selectResults: {
        workflow_canvas_history: [{
          data: { id: 'history-1', canvas_id: 'canvas-1', title: 'Earlier', graph },
          error: null,
        }],
        workflow_canvases: [{ data: { id: 'canvas-1', revision: 2 }, error: null }],
      },
      updateResults: {
        workflow_canvases: [{ data: null, error: new Error('write failed') }],
      },
    });

    await expect(restoreWorkflowCanvasHistoryForRoute({
      canvasId: 'canvas-1',
      entryId: 'history-1',
      supabase: supabase.client as never,
      userId: 'user-1',
    })).resolves.toEqual({
      ok: false,
      status: 500,
      body: { error: 'Failed to restore workflow history.' },
    });

    expect(supabase.insertCalls).toEqual([]);
  });
});
