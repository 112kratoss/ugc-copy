import { beforeEach, describe, expect, it, vi } from 'vitest';

import { expectFailure } from '@/__tests__/fixtures/route-result';

import {
  startWorkflowRunForRoute,
  type WorkflowRunRouteSupabaseClient,
} from '@/lib/workflow-run-route-service';
import { createStarterGraph, normalizeWorkflowGraph } from '@/lib/workflow-canvas';

const rateLimitAllowed = {
  allowed: true,
  limit: 20,
  remaining: 19,
  retryAfterSeconds: 0,
  resetAt: '2026-06-23T05:00:00.000Z',
};

function createAdminClient({ allowed = true } = {}) {
  const rpc = vi.fn(async () => ({
    data: allowed
      ? rateLimitAllowed
      : {
          ...rateLimitAllowed,
          allowed: false,
          remaining: 0,
          retryAfterSeconds: 42,
        },
    error: null,
  }));

  return {
    client: { rpc },
    rpc,
  };
}

function createCanvasClient({
  canvas = {
    id: 'canvas-1',
    graph: createStarterGraph(),
  } as { id: string; graph: unknown } | null,
} = {}) {
  const from = vi.fn((table: string) => {
    if (table !== 'workflow_canvases') {
      throw new Error(`Unexpected table: ${table}`);
    }

    const query = {
      select() {
        return query;
      },
      eq() {
        return query;
      },
      async single() {
        return canvas
          ? { data: canvas, error: null }
          : { data: null, error: { message: 'not found' } };
      },
    };

    return query;
  });

  return {
    // Deliberate partial double: the route only reads a single canvas row, so
    // the stub implements one from().select().eq().eq().single() chain against
    // a client interface with dozens of members. Widen once at the factory
    // rather than at each call site.
    client: { from } as unknown as WorkflowRunRouteSupabaseClient,
    from,
  };
}

describe('startWorkflowRunForRoute', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects missing start nodes before privileged rate-limit or canvas work', async () => {
    const canvas = createCanvasClient();
    const adminFactory = vi.fn(() => createAdminClient().client);
    const executeRun = vi.fn();
    const scheduleMonitor = vi.fn();

    const result = await startWorkflowRunForRoute({
      supabase: canvas.client,
      adminSupabase: adminFactory,
      userId: 'user-1',
      canvasId: 'canvas-1',
      body: { mode: 'branch' },
      executeRun,
      scheduleMonitor,
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      body: { error: 'A start node is required.' },
    });
    expect(adminFactory).not.toHaveBeenCalled();
    expect(canvas.from).not.toHaveBeenCalled();
    expect(executeRun).not.toHaveBeenCalled();
    expect(scheduleMonitor).not.toHaveBeenCalled();
  });

  it('rate limits workflow starts before loading the canvas or starting runner work', async () => {
    const canvas = createCanvasClient();
    const admin = createAdminClient({ allowed: false });
    const executeRun = vi.fn();

    const result = await startWorkflowRunForRoute({
      supabase: canvas.client,
      adminSupabase: admin.client,
      userId: 'user-1',
      canvasId: 'canvas-1',
      body: { startNodeId: 'node-1' },
      executeRun,
      scheduleMonitor: vi.fn(),
    });

    expect(result).toMatchObject({
      ok: false,
      status: 429,
      body: {
        code: 'RATE_LIMITED',
        retryAfterSeconds: 42,
      },
    });
    expect(expectFailure(result).rateLimitError?.retryAfterSeconds).toBe(42);
    expect(admin.rpc).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'workflow-run:start',
      p_subject_key: 'user-1',
      p_limit: 20,
      p_window_seconds: 600,
    });
    expect(canvas.from).not.toHaveBeenCalled();
    expect(executeRun).not.toHaveBeenCalled();
  });

  it('returns not found when the authenticated owner cannot access the canvas', async () => {
    const canvas = createCanvasClient({ canvas: null });
    const admin = createAdminClient();
    const executeRun = vi.fn();

    const result = await startWorkflowRunForRoute({
      supabase: canvas.client,
      adminSupabase: admin.client,
      userId: 'user-1',
      canvasId: 'missing-canvas',
      body: { startNodeId: 'node-1' },
      executeRun,
      scheduleMonitor: vi.fn(),
    });

    expect(result).toEqual({
      ok: false,
      status: 404,
      body: { error: 'Workflow canvas not found.' },
    });
    expect(admin.rpc).toHaveBeenCalledTimes(1);
    expect(executeRun).not.toHaveBeenCalled();
  });

  it('executes normalized workflow runs and schedules monitoring while processing', async () => {
    const graph = normalizeWorkflowGraph(createStarterGraph());
    const canvas = createCanvasClient({ canvas: { id: 'canvas-1', graph } });
    const admin = createAdminClient();
    const executeRun = vi.fn(async () => ({
      runId: 'run-1',
      status: 'processing' as const,
    }));
    const monitorRun = vi.fn(async () => null);
    const scheduleMonitor = vi.fn((job: () => Promise<void>) => {
      void job();
    });

    const result = await startWorkflowRunForRoute({
      supabase: canvas.client,
      adminSupabase: admin.client,
      userId: 'user-1',
      canvasId: 'canvas-1',
      body: {
        startNodeId: 'node-1',
        mode: 'node',
        catalogRevision: 'catalog-rev-1',
      },
      executeRun,
      monitorRun,
      scheduleMonitor,
    });

    expect(result).toEqual({
      ok: true,
      body: {
        runId: 'run-1',
        status: 'processing',
      },
    });
    expect(executeRun).toHaveBeenCalledWith({
      supabase: canvas.client,
      userId: 'user-1',
      canvasId: 'canvas-1',
      graph,
      startNodeId: 'node-1',
      mode: 'node',
      catalogRevision: 'catalog-rev-1',
    });
    expect(scheduleMonitor).toHaveBeenCalledTimes(1);
    expect(monitorRun).toHaveBeenCalledWith({
      canvasId: 'canvas-1',
      runId: 'run-1',
    });
  });

  it('maps runner failures to a fixed 500 response without leaking error details', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const canvas = createCanvasClient();
    const admin = createAdminClient();

    const result = await startWorkflowRunForRoute({
      supabase: canvas.client,
      adminSupabase: admin.client,
      userId: 'user-1',
      canvasId: 'canvas-1',
      body: { startNodeId: 'node-1' },
      executeRun: vi.fn(async () => {
        throw new Error('connection refused: db-internal:5432');
      }),
      scheduleMonitor: vi.fn(),
    });

    expect(result).toEqual({
      ok: false,
      status: 500,
      body: { error: 'Workflow run failed.' },
    });
  });
});
