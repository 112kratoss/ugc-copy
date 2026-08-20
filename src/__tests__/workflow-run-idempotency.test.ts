import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createWorkflowNode,
  normalizeWorkflowGraph,
  type TextInputNodeData,
} from '@/lib/workflow-canvas';

const enqueueWorkflowRunStepJobMock = vi.fn(async () => 'job-1');

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => ({ role: 'service' }),
  resolveOwnedStoredMediaUrl: async (_client: unknown, url: string) => url,
}));

vi.mock('@/lib/generation-status-sync', () => ({
  syncGenerationStatuses: vi.fn(async () => undefined),
}));

vi.mock('@/lib/generation-services', () => ({
  startImageGeneration: vi.fn(),
  startMotionGeneration: vi.fn(),
  startSoundEffectGeneration: vi.fn(),
  startVideoGeneration: vi.fn(),
  startVoiceoverGeneration: vi.fn(),
}));

vi.mock('@/lib/generation-model-catalog-store', () => ({
  quotePublishedGenerationModel: vi.fn(() => ({
    modelId: 'x',
    catalogRevision: 'r',
    normalizedSettings: {},
    costCredits: 1,
  })),
}));

vi.mock('@/lib/workflow-run-jobs', () => ({
  enqueueWorkflowRunStepJob: (...args: unknown[]) => enqueueWorkflowRunStepJobMock(...(args as [])),
}));

type StartRunReply = { run_id: string; run_status: string; reused: boolean };

function createRunnerClient(startRunReply: StartRunReply | { error: { message: string } }) {
  const stepInserts: Record<string, unknown>[] = [];
  const runUpdates: Record<string, unknown>[] = [];
  const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];

  const client = {
    async rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args });
      if ('error' in startRunReply) return { data: null, error: startRunReply.error };
      return { data: [startRunReply], error: null };
    },
    from(table: string) {
      if (table === 'workflow_canvas_run_steps') {
        return {
          async insert(row: Record<string, unknown>) {
            stepInserts.push(row);
            return { data: null, error: null };
          },
        };
      }

      if (table === 'workflow_canvas_runs') {
        return {
          update(updates: Record<string, unknown>) {
            runUpdates.push(updates);
            return { eq: async () => ({ data: null, error: null }) };
          },
        };
      }

      throw new Error(`Unexpected table access: ${table}`);
    },
  };

  return { client, stepInserts, runUpdates, rpcCalls };
}

function createSingleNodeGraph() {
  const node = createWorkflowNode('text-input', { x: 0, y: 0 });
  return normalizeWorkflowGraph({
    nodes: [{ ...node, data: { ...(node.data as TextInputNodeData), text: 'hello' } }],
    edges: [],
  });
}

describe('workflow run idempotency (F12)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not execute the graph again when an idempotency key replays', async () => {
    // The money bug. A timed-out client retry used to create a second run and
    // re-charge every node's generation; per-generation idempotency cannot
    // catch it, because each new run legitimately starts new generations. The
    // early return -- not just the unique index -- is what stops the spend.
    const graph = createSingleNodeGraph();
    const { client, stepInserts, runUpdates } = createRunnerClient({
      run_id: 'run-existing',
      run_status: 'processing',
      reused: true,
    });

    const { executeWorkflowRun } = await import('@/lib/workflow-runner');
    const result = await executeWorkflowRun({
      supabase: client as never,
      userId: 'user-1',
      canvasId: 'canvas-1',
      graph,
      startNodeId: graph.nodes[0].id,
      mode: 'node',
      idempotencyKey: 'key-abc',
    });

    expect(result).toEqual({ runId: 'run-existing', status: 'processing', reused: true });
    expect(stepInserts).toHaveLength(0);
    expect(runUpdates).toHaveLength(0);
    // Nothing new to watch either -- the original run is already being driven.
    expect(enqueueWorkflowRunStepJobMock).not.toHaveBeenCalled();
  });

  it('executes normally and reports reused:false for a fresh key', async () => {
    const graph = createSingleNodeGraph();
    const { client, stepInserts, rpcCalls } = createRunnerClient({
      run_id: 'run-new',
      run_status: 'processing',
      reused: false,
    });

    const { executeWorkflowRun } = await import('@/lib/workflow-runner');
    const result = await executeWorkflowRun({
      supabase: client as never,
      userId: 'user-1',
      canvasId: 'canvas-1',
      graph,
      startNodeId: graph.nodes[0].id,
      mode: 'node',
      idempotencyKey: 'key-fresh',
    });

    expect(result.reused).toBe(false);
    expect(result.runId).toBe('run-new');
    // Initialization owns the full handoff; the request never inserts steps
    // one by one or starts provider work outside the durable lease.
    expect(stepInserts).toHaveLength(0);
    expect(rpcCalls[0]).toMatchObject({
      fn: 'initialize_workflow_canvas_run',
      args: {
        p_idempotency_key: 'key-fresh',
        p_canvas_id: 'canvas-1',
        p_user_id: 'user-1',
        p_step_skeleton: [{ nodeId: graph.nodes[0].id }],
      },
    });
  });

  it('rejects a keyless run before calling the creation RPC', async () => {
    const graph = createSingleNodeGraph();
    const { client, rpcCalls } = createRunnerClient({
      run_id: 'run-new',
      run_status: 'succeeded',
      reused: false,
    });

    const { executeWorkflowRun } = await import('@/lib/workflow-runner');
    await expect(executeWorkflowRun({
      supabase: client as never,
      userId: 'user-1',
      canvasId: 'canvas-1',
      graph,
      startNodeId: graph.nodes[0].id,
      mode: 'node',
    })).rejects.toThrow('Workflow run idempotency key is required.');

    expect(rpcCalls).toHaveLength(0);
  });

  it('throws instead of writing steps against a null run when creation fails', async () => {
    // The old insert never read its error, so a failed insert left runId
    // undefined and every step below was written against a null run.
    const graph = createSingleNodeGraph();
    const { client, stepInserts } = createRunnerClient({ error: { message: 'insert denied' } });

    const { executeWorkflowRun } = await import('@/lib/workflow-runner');
    await expect(executeWorkflowRun({
      supabase: client as never,
      userId: 'user-1',
      canvasId: 'canvas-1',
      graph,
      startNodeId: graph.nodes[0].id,
      mode: 'node',
      idempotencyKey: 'key-failed-create',
    })).rejects.toMatchObject({ message: 'insert denied' });

    expect(stepInserts).toHaveLength(0);
  });
});
