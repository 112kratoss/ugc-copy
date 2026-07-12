import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStarterGraph } from '@/lib/workflow-canvas';

const afterMock = vi.fn((callback: () => Promise<void> | void) => callback());
const executeWorkflowRunMock = vi.fn();
const monitorWorkflowRunMock = vi.fn();
const getWorkflowRunDetailsMock = vi.fn();
const approveWorkflowRunStepMock = vi.fn();
let runRateLimitAllowed = true;
let runAdminRpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];

vi.mock('next/server', async () => {
  const actual = await vi.importActual<typeof import('next/server')>('next/server');

  return {
    ...actual,
    after: afterMock,
  };
});

vi.mock('@/lib/workflow-runner', () => ({
  approveWorkflowRunStep: (...args: unknown[]) => approveWorkflowRunStepMock(...args),
  executeWorkflowRun: (...args: unknown[]) => executeWorkflowRunMock(...args),
  monitorWorkflowRun: (...args: unknown[]) => monitorWorkflowRunMock(...args),
  getWorkflowRunDetails: (...args: unknown[]) => getWorkflowRunDetailsMock(...args),
  WorkflowRunApprovalError: class WorkflowRunApprovalError extends Error {
    constructor(message: string, public readonly status: number) {
      super(message);
    }
  },
}));

function createSupabaseMock() {
  return {
    from(table: string) {
      if (table !== 'workflow_canvases') {
        throw new Error(`Unexpected table: ${table}`);
      }

      return {
        select() {
          const query = {
            eq() {
              return query;
            },
            async single() {
              return {
                data: {
                  id: 'canvas-1',
                  graph: createStarterGraph(),
                },
                error: null,
              };
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
  authenticateRequest: () => authenticateRequestMock(),
  createServiceClient: () => ({
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      runAdminRpcCalls.push({ fn, args });

      if (fn === 'check_backend_rate_limit') {
        return {
          data: {
            allowed: runRateLimitAllowed,
            limit: 20,
            remaining: runRateLimitAllowed ? 19 : 0,
            retryAfterSeconds: runRateLimitAllowed ? 0 : 42,
            resetAt: '2026-06-21T06:30:00.000Z',
          },
          error: null,
        };
      }

      throw new Error(`Unexpected rpc: ${fn}`);
    }),
  }),
}));

function expectPrivateNoStoreTraceHeaders(response: Response, requestId: string) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('x-request-id')).toBe(requestId);
}

describe('workflow run routes', () => {
  beforeEach(() => {
    vi.resetModules();
    runRateLimitAllowed = true;
    runAdminRpcCalls = [];
    afterMock.mockClear();
    executeWorkflowRunMock.mockReset();
    monitorWorkflowRunMock.mockReset();
    getWorkflowRunDetailsMock.mockReset();
    approveWorkflowRunStepMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POST /run rate limits workflow execution before starting runner work', async () => {
    runRateLimitAllowed = false;
    executeWorkflowRunMock.mockResolvedValue({
      runId: 'run-1',
      status: 'processing',
    });

    const { POST } = await import('@/app/api/workflow-canvases/[id]/run/route');
    const response = await POST(
      new Request('http://localhost/api/workflow-canvases/canvas-1/run', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'workflow-run-rate-limit-1',
        },
        body: JSON.stringify({
          startNodeId: 'node-1',
          mode: 'branch',
        }),
      }) as never,
      { params: Promise.resolve({ id: 'canvas-1' }) }
    );

    expect(response.status).toBe(429);
    expectPrivateNoStoreTraceHeaders(response, 'workflow-run-rate-limit-1');
    await expect(response.json()).resolves.toMatchObject({ code: 'RATE_LIMITED' });
    expect(runAdminRpcCalls).toHaveLength(1);
    expect(runAdminRpcCalls[0]).toMatchObject({
      fn: 'check_backend_rate_limit',
      args: {
        p_scope: 'workflow-run:start',
        p_subject_key: 'user-1',
      },
    });
    expect(executeWorkflowRunMock).not.toHaveBeenCalled();
    expect(afterMock).not.toHaveBeenCalled();
  });

  it('POST /run schedules the monitor once when execution is still processing', async () => {
    executeWorkflowRunMock.mockResolvedValue({
      runId: 'run-1',
      status: 'processing',
    });
    monitorWorkflowRunMock.mockResolvedValue(null);

    const { POST } = await import('@/app/api/workflow-canvases/[id]/run/route');
    const response = await POST(
      new Request('http://localhost/api/workflow-canvases/canvas-1/run', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'workflow-run-success-1',
        },
        body: JSON.stringify({
          startNodeId: 'node-1',
          mode: 'branch',
          catalogRevision: 'catalog-rev-1',
        }),
      }) as never,
      { params: Promise.resolve({ id: 'canvas-1' }) }
    );

    expect(response.status).toBe(200);
    expectPrivateNoStoreTraceHeaders(response, 'workflow-run-success-1');
    expect(afterMock).toHaveBeenCalledTimes(1);
    expect(monitorWorkflowRunMock).toHaveBeenCalledTimes(1);
    expect(monitorWorkflowRunMock).toHaveBeenCalledWith({
      canvasId: 'canvas-1',
      runId: 'run-1',
    });
    expect(executeWorkflowRunMock).toHaveBeenCalledWith(expect.objectContaining({
      catalogRevision: 'catalog-rev-1',
    }));
  });

  it('GET /runs/[runId] returns runner-managed recovery state without scheduling monitoring', async () => {
    getWorkflowRunDetailsMock.mockResolvedValue({
      id: 'run-1',
      canvas_id: 'canvas-1',
      start_node_id: 'node-1',
      mode: 'branch',
      status: 'processing',
      created_at: '2026-03-24T11:00:00.000Z',
      finished_at: null,
      steps: [],
    });

    const { GET } = await import('@/app/api/workflow-canvases/[id]/runs/[runId]/route');
    const response = await GET(
      new Request('http://localhost/api/workflow-canvases/canvas-1/runs/run-1') as never,
      { params: Promise.resolve({ id: 'canvas-1', runId: 'run-1' }) }
    );

    expect(response.status).toBe(200);
    expect(afterMock).not.toHaveBeenCalled();
    expect(monitorWorkflowRunMock).not.toHaveBeenCalled();
  });

  it('POST approval-steps/[stepId]/approve resumes a paused workflow run', async () => {
    approveWorkflowRunStepMock.mockResolvedValue({
      id: 'run-1',
      canvas_id: 'canvas-1',
      status: 'processing',
      steps: [],
    });

    const { POST } = await import('@/app/api/workflow-canvases/[id]/runs/[runId]/approval-steps/[stepId]/approve/route');
    const response = await POST(
      new Request('http://localhost/api/workflow-canvases/canvas-1/runs/run-1/approval-steps/step-1/approve', {
        method: 'POST',
        headers: { 'x-request-id': 'workflow-run-approval-route-1' },
      }) as never,
      {
        params: Promise.resolve({
          id: 'canvas-1',
          runId: 'run-1',
          stepId: 'step-1',
        }),
      },
    );

    expect(response.status).toBe(200);
    expectPrivateNoStoreTraceHeaders(response, 'workflow-run-approval-route-1');
    expect(approveWorkflowRunStepMock).toHaveBeenCalledWith(expect.objectContaining({
      canvasId: 'canvas-1',
      runId: 'run-1',
      stepId: 'step-1',
    }));
  });
});
