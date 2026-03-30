import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStarterGraph } from '@/lib/workflow-canvas';

const afterMock = vi.fn((callback: () => Promise<void> | void) => callback());
const executeWorkflowRunMock = vi.fn();
const monitorWorkflowRunMock = vi.fn();
const getWorkflowRunDetailsMock = vi.fn();

vi.mock('next/server', async () => {
  const actual = await vi.importActual<typeof import('next/server')>('next/server');

  return {
    ...actual,
    after: afterMock,
  };
});

vi.mock('@/lib/workflow-runner', () => ({
  executeWorkflowRun: (...args: unknown[]) => executeWorkflowRunMock(...args),
  monitorWorkflowRun: (...args: unknown[]) => monitorWorkflowRunMock(...args),
  getWorkflowRunDetails: (...args: unknown[]) => getWorkflowRunDetailsMock(...args),
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
  authenticateRequest: (..._args: unknown[]) => authenticateRequestMock(),
}));

describe('workflow run routes', () => {
  beforeEach(() => {
    vi.resetModules();
    afterMock.mockClear();
    executeWorkflowRunMock.mockReset();
    monitorWorkflowRunMock.mockReset();
    getWorkflowRunDetailsMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startNodeId: 'node-1',
          mode: 'branch',
        }),
      }) as never,
      { params: Promise.resolve({ id: 'canvas-1' }) }
    );

    expect(response.status).toBe(200);
    expect(afterMock).toHaveBeenCalledTimes(1);
    expect(monitorWorkflowRunMock).toHaveBeenCalledTimes(1);
    expect(monitorWorkflowRunMock).toHaveBeenCalledWith({
      canvasId: 'canvas-1',
      runId: 'run-1',
    });
  });

  it('GET /runs/[runId] stays read-only and does not schedule monitoring', async () => {
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
});
