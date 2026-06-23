import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  createWorkflowCanvasForRoute,
  listWorkflowCanvasesForRoute,
  type WorkflowCanvasCollectionServiceClient,
} from '@/lib/workflow-canvas-collection-service';
import { createStarterGraph } from '@/lib/workflow-canvas';

type WorkflowCanvasListRow = {
  id: string;
  title: string;
  updated_at: string;
  revision: number;
  status?: string | null;
  published_at?: string | null;
};

type WorkflowCanvasRouteRow = WorkflowCanvasListRow & {
  graph: ReturnType<typeof createStarterGraph>;
  created_at: string;
};

function lifecycleColumnError() {
  return { code: '42703', message: 'column workflow_canvases.status does not exist' };
}

function historyTableMissingError() {
  return { code: '42P01', message: 'relation "workflow_canvas_history" does not exist' };
}

function createWorkflowSupabaseMock(options?: {
  fallbackList?: boolean;
  fallbackInsert?: boolean;
  historyMissing?: boolean;
}) {
  const listRows: WorkflowCanvasListRow[] = [{
    id: 'canvas-1',
    title: 'Workflow canvas',
    updated_at: '2026-03-24T11:00:00.000Z',
    revision: 2,
    status: 'published',
    published_at: '2026-03-24T11:01:00.000Z',
  }];
  const insertedPayloads: Array<Record<string, unknown>> = [];
  const historyInserts: Array<Record<string, unknown>> = [];
  const listSelects: string[] = [];

  const client = {
    from(table: string) {
      if (table === 'workflow_canvases') {
        return {
          select(columns?: string) {
            listSelects.push(columns ?? '');
            const query = {
              eq() {
                return query;
              },
              async order() {
                if (options?.fallbackList && columns?.includes('status')) {
                  return { data: null, error: lifecycleColumnError() };
                }

                if (columns?.includes('status')) {
                  return { data: listRows, error: null };
                }

                return {
                  data: listRows.map((row) => ({
                    id: row.id,
                    title: row.title,
                    updated_at: row.updated_at,
                    revision: row.revision,
                  })),
                  error: null,
                };
              },
            };

            return query;
          },
          insert(payload: Record<string, unknown>) {
            insertedPayloads.push(payload);
            return {
              select(columns?: string) {
                return {
                  async single() {
                    if (options?.fallbackInsert && 'status' in payload) {
                      return { data: null, error: lifecycleColumnError() };
                    }

                    const row: WorkflowCanvasRouteRow = {
                      id: 'canvas-2',
                      title: String(payload.title),
                      graph: createStarterGraph(),
                      created_at: '2026-03-24T11:02:00.000Z',
                      updated_at: '2026-03-24T11:02:00.000Z',
                      revision: 0,
                      ...(columns?.includes('status') ? { status: 'draft', published_at: null } : {}),
                    };

                    return { data: row, error: null };
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

      throw new Error(`Unexpected table: ${table}`);
    },
  };

  return {
    client: client as unknown as SupabaseClient,
    historyInserts,
    insertedPayloads,
    listSelects,
  };
}

function createRateLimitClient({ allowed = true } = {}) {
  const rpc = vi.fn(async () => ({
    data: {
      allowed,
      limit: 240,
      remaining: allowed ? 239 : 0,
      retryAfterSeconds: allowed ? 0 : 42,
      resetAt: '2026-06-22T06:30:00.000Z',
    },
    error: null,
  }));

  return {
    client: { rpc } satisfies WorkflowCanvasCollectionServiceClient,
    rpc,
  };
}

describe('workflow canvas collection service', () => {
  it('lists sidebar canvas metadata with lifecycle fallback defaults', async () => {
    const supabase = createWorkflowSupabaseMock({ fallbackList: true });

    const result = await listWorkflowCanvasesForRoute({
      supabase: supabase.client,
      userId: 'user-1',
    });

    expect(result).toEqual({
      ok: true,
      body: {
        canvases: [{
          id: 'canvas-1',
          title: 'Workflow canvas',
          updated_at: '2026-03-24T11:00:00.000Z',
          revision: 2,
          status: 'draft',
          published_at: null,
        }],
      },
    });
    expect(supabase.listSelects).toEqual([
      'id,title,updated_at,revision,status,published_at',
      'id,title,updated_at,revision',
    ]);
  });

  it('rate limits canvas creation before parsing the request body', async () => {
    const supabase = createWorkflowSupabaseMock();
    const rateLimit = createRateLimitClient({ allowed: false });
    const readBody = vi.fn(async () => ({ title: 'New canvas' }));

    const result = await createWorkflowCanvasForRoute({
      supabase: supabase.client,
      rateLimitClient: rateLimit.client,
      userId: 'user-1',
      readBody,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 429,
      body: {
        code: 'RATE_LIMITED',
        retryAfterSeconds: 42,
      },
    });
    expect(rateLimit.rpc).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'workflow-canvas:mutate',
      p_subject_key: 'user-1',
      p_limit: 240,
      p_window_seconds: 600,
    });
    expect(readBody).not.toHaveBeenCalled();
    expect(supabase.insertedPayloads).toEqual([]);
  });

  it('creates a draft canvas with legacy insert and missing-history fallback', async () => {
    const supabase = createWorkflowSupabaseMock({
      fallbackInsert: true,
      historyMissing: true,
    });
    const rateLimit = createRateLimitClient();

    const result = await createWorkflowCanvasForRoute({
      supabase: supabase.client,
      rateLimitClient: rateLimit.client,
      userId: 'user-1',
      readBody: vi.fn(async () => ({ title: 'Fallback canvas', graph: createStarterGraph() })),
    });

    expect(result).toMatchObject({
      ok: true,
      body: {
        canvas: {
          id: 'canvas-2',
          title: 'Fallback canvas',
          status: 'draft',
          published_at: null,
        },
      },
    });
    expect(supabase.insertedPayloads).toHaveLength(2);
    expect(supabase.insertedPayloads[0]).toHaveProperty('status', 'draft');
    expect(supabase.insertedPayloads[1]).not.toHaveProperty('status');
    expect(supabase.historyInserts[0]).toMatchObject({
      canvas_id: 'canvas-2',
      user_id: 'user-1',
      title: 'Fallback canvas',
      revision: 0,
      kind: 'draft',
    });
  });
});
