import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  attachGenerationProviderTask,
  settleGenerationFailed,
  syncGenerationStatusByPredictionId,
} from '@/lib/generation-services';
import {
  claimGenerationCompletionJobs,
  enqueueGenerationCompletionJob,
  finishGenerationCompletionJob,
  getGenerationCompletionRetryDelaySeconds,
  hasDueGenerationCompletionJobs,
  maybePruneGenerationCompletionJobs,
  processGenerationCompletionJobs,
  pruneGenerationCompletionJobs,
  shouldPruneGenerationCompletionJobs,
} from '@/lib/generation-completion-jobs';

vi.mock('@/lib/generation-services', () => ({
  attachGenerationProviderTask: vi.fn(),
  settleGenerationFailed: vi.fn(),
  syncGenerationStatusByPredictionId: vi.fn(),
}));

function createRpcClient(results: Array<{ data: unknown; error: Error | null }>) {
  return {
    rpc: vi.fn(async () => {
      const result = results.shift();
      if (!result) throw new Error('Unexpected RPC call');
      return result;
    }),
  };
}

function createCompletionWorkerClient(results: Array<{ data: unknown; error: Error | null }>) {
  const updateIs = vi.fn(async () => ({ data: null, error: null }));
  const updateEq = vi.fn(() => ({ is: updateIs }));
  const update = vi.fn(() => ({ eq: updateEq }));
  const from = vi.fn(() => ({ update }));

  return {
    ...createRpcClient(results),
    from,
    update,
    updateEq,
    updateIs,
  };
}

function createDueProbeClient(results: Array<{ data: unknown[] | null; error: Error | null }>) {
  const limit = vi.fn(async () => {
    const result = results.shift();
    if (!result) throw new Error('Unexpected due probe query');
    return result;
  });
  const lte = vi.fn(() => ({ limit }));
  const eq = vi.fn(() => ({ lte }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));

  return {
    from,
    select,
    eq,
    lte,
    limit,
  };
}

describe('generation completion jobs', () => {
  beforeEach(() => {
    vi.mocked(attachGenerationProviderTask).mockReset();
    vi.mocked(attachGenerationProviderTask).mockResolvedValue('attached');
    vi.mocked(settleGenerationFailed).mockReset();
    vi.mocked(settleGenerationFailed).mockResolvedValue('failed');
    vi.mocked(syncGenerationStatusByPredictionId).mockReset();
  });

  it('enqueues a provider task completion idempotently', async () => {
    const client = createRpcClient([{ data: 'job-1', error: null }]);

    await expect(enqueueGenerationCompletionJob(client, {
      predictionId: 'task-1',
      payload: { data: { taskId: 'task-1' } },
    })).resolves.toBe('job-1');

    expect(client.rpc).toHaveBeenCalledWith('enqueue_generation_completion_job', {
      p_prediction_id: 'task-1',
      p_payload: { data: { taskId: 'task-1' } },
    });
  });

  it('claims bounded pending work through the pooled-safe RPC', async () => {
    const rows = [{ id: 'job-1', prediction_id: 'task-1', locked_by: 'worker-1' }];
    const client = createRpcClient([{ data: rows, error: null }]);

    await expect(claimGenerationCompletionJobs(client, {
      limit: 10,
      lockedBy: 'worker-1',
      predictionId: 'task-1',
    })).resolves.toEqual(rows);

    expect(client.rpc).toHaveBeenCalledWith('claim_generation_completion_jobs', {
      p_limit: 10,
      p_locked_by: 'worker-1',
      p_lock_ttl_seconds: 300,
      p_prediction_id: 'task-1',
    });
  });

  it('finishes and prunes completion jobs through bounded RPCs', async () => {
    const client = createRpcClient([
      { data: 'succeeded', error: null },
      { data: 7, error: null },
    ]);

    await expect(finishGenerationCompletionJob(client, {
      id: 'job-1',
      lockedBy: 'worker-1',
      succeeded: true,
    })).resolves.toBe('succeeded');
    await expect(pruneGenerationCompletionJobs(client)).resolves.toBe(7);

    expect(client.rpc).toHaveBeenNthCalledWith(1, 'finish_generation_completion_job', {
      p_id: 'job-1',
      p_locked_by: 'worker-1',
      p_succeeded: true,
      p_error: null,
      p_retry_delay_seconds: 60,
    });
    expect(client.rpc).toHaveBeenNthCalledWith(2, 'prune_generation_completion_jobs', {
      p_retention_days: 30,
      p_limit: 500,
    });
  });

  it('calculates bounded exponential retry delays from claimed attempt counts', () => {
    expect(getGenerationCompletionRetryDelaySeconds(0)).toBe(60);
    expect(getGenerationCompletionRetryDelaySeconds(1)).toBe(60);
    expect(getGenerationCompletionRetryDelaySeconds(2)).toBe(120);
    expect(getGenerationCompletionRetryDelaySeconds(3)).toBe(240);
    expect(getGenerationCompletionRetryDelaySeconds(4)).toBe(480);
    expect(getGenerationCompletionRetryDelaySeconds(5)).toBe(900);
    expect(getGenerationCompletionRetryDelaySeconds(99)).toBe(900);
  });

  it('limits automatic completion queue pruning to the top of each hour', () => {
    expect(shouldPruneGenerationCompletionJobs(Date.UTC(2026, 5, 21, 10, 0))).toBe(true);
    expect(shouldPruneGenerationCompletionJobs(Date.UTC(2026, 5, 21, 10, 4))).toBe(true);
    expect(shouldPruneGenerationCompletionJobs(Date.UTC(2026, 5, 21, 10, 5))).toBe(false);
    expect(shouldPruneGenerationCompletionJobs(Date.UTC(2026, 5, 21, 10, 59))).toBe(false);
  });

  it('checks for due completion jobs with indexed one-row probes', async () => {
    const client = createDueProbeClient([
      { data: [], error: null },
      { data: [{ id: 'job-2' }], error: null },
    ]);

    await expect(hasDueGenerationCompletionJobs(client as never, {
      nowMs: Date.UTC(2026, 5, 21, 10, 15, 0),
      lockTtlSeconds: 300,
    })).resolves.toBe(true);

    expect(client.from).toHaveBeenCalledWith('generation_completion_jobs');
    expect(client.eq).toHaveBeenNthCalledWith(1, 'status', 'pending');
    expect(client.lte).toHaveBeenNthCalledWith(1, 'next_attempt_at', '2026-06-21T10:15:00.000Z');
    expect(client.eq).toHaveBeenNthCalledWith(2, 'status', 'processing');
    expect(client.lte).toHaveBeenNthCalledWith(2, 'locked_at', '2026-06-21T10:10:00.000Z');
    expect(client.limit).toHaveBeenCalledWith(1);
  });

  it('skips automatic completion queue pruning outside the cleanup window', async () => {
    const client = createRpcClient([{ data: 7, error: null }]);

    await expect(maybePruneGenerationCompletionJobs(client, {
      nowMs: Date.UTC(2026, 5, 21, 10, 30),
    })).resolves.toBeNull();

    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('runs automatic completion queue pruning during the cleanup window', async () => {
    const client = createRpcClient([{ data: 4, error: null }]);

    await expect(maybePruneGenerationCompletionJobs(client, {
      nowMs: Date.UTC(2026, 5, 21, 10, 2),
      retentionDays: 45,
      limit: 750,
    })).resolves.toBe(4);

    expect(client.rpc).toHaveBeenCalledWith('prune_generation_completion_jobs', {
      p_retention_days: 45,
      p_limit: 750,
    });
  });

  it('throws database errors instead of silently dropping completion work', async () => {
    const client = createRpcClient([{ data: null, error: new Error('database unavailable') }]);

    await expect(enqueueGenerationCompletionJob(client, {
      predictionId: 'task-1',
      payload: {},
    })).rejects.toThrow('database unavailable');
  });

  it('marks claimed jobs complete after a terminal generation sync', async () => {
    const webhookPayload = { data: { taskId: 'task-1', state: 'success' } };
    const client = createRpcClient([
      {
        data: [{
          id: 'job-1',
          prediction_id: 'task-1',
          payload: webhookPayload,
          status: 'processing',
          attempt_count: 1,
          locked_by: 'worker-1',
        }],
        error: null,
      },
      { data: 'succeeded', error: null },
    ]);
    vi.mocked(syncGenerationStatusByPredictionId).mockResolvedValue({
      found: true,
      status: 'succeeded',
      generation: {
        id: 'generation-1',
        user_id: 'user-1',
        prediction_id: 'task-1',
        status: 'succeeded',
        output_url: null,
        category: 'image',
        model: 'nanobanana',
        workflow_settings: null,
        created_at: '2026-06-21T10:00:00.000Z',
        completed_at: '2026-06-21T10:01:00.000Z',
      },
    });

    await expect(processGenerationCompletionJobs({
      supabase: client as never,
      creditSupabase: client as never,
      lockedBy: 'worker-1',
      limit: 5,
    })).resolves.toEqual({
      claimed: 1,
      completed: 1,
      retried: 0,
      failed: 0,
    });

    expect(syncGenerationStatusByPredictionId).toHaveBeenCalledWith({
      supabase: client,
      creditSupabase: client,
      predictionId: 'task-1',
      providerPayload: webhookPayload,
    });
    expect(client.rpc).toHaveBeenNthCalledWith(1, 'claim_generation_completion_jobs', {
      p_limit: 5,
      p_locked_by: 'worker-1',
      p_lock_ttl_seconds: 300,
      p_prediction_id: null,
    });
    expect(client.rpc).toHaveBeenNthCalledWith(2, 'finish_generation_completion_job', {
      p_id: 'job-1',
      p_locked_by: 'worker-1',
      p_succeeded: true,
      p_error: null,
      p_retry_delay_seconds: 60,
    });
  });

  it('reattaches callback generation ids and retries missing provider task lookups', async () => {
    const webhookPayload = {
      data: { taskId: 'task-1', state: 'success' },
      magicbooklet: { callbackGenerationId: 'generation-1' },
    };
    const client = createCompletionWorkerClient([
      {
        data: [{
          id: 'job-1',
          prediction_id: 'task-1',
          payload: webhookPayload,
          status: 'processing',
          attempt_count: 1,
          locked_by: 'worker-1',
        }],
        error: null,
      },
      { data: 'succeeded', error: null },
    ]);
    vi.mocked(syncGenerationStatusByPredictionId)
      .mockResolvedValueOnce({ found: false, status: 'missing', generation: null })
      .mockResolvedValueOnce({
        found: true,
        status: 'succeeded',
        generation: {
          id: 'generation-1',
          user_id: 'user-1',
          prediction_id: 'task-1',
          status: 'succeeded',
          output_url: null,
          category: 'image',
          model: 'nanobanana',
          workflow_settings: null,
          created_at: '2026-06-21T10:00:00.000Z',
          completed_at: '2026-06-21T10:01:00.000Z',
        },
      });

    await expect(processGenerationCompletionJobs({
      supabase: client as never,
      creditSupabase: client as never,
      lockedBy: 'worker-1',
      limit: 5,
    })).resolves.toEqual({
      claimed: 1,
      completed: 1,
      retried: 0,
      failed: 0,
    });

    expect(syncGenerationStatusByPredictionId).toHaveBeenCalledTimes(2);
    expect(attachGenerationProviderTask).toHaveBeenCalledWith(client, {
      generationId: 'generation-1',
      predictionId: 'task-1',
    });
    expect(client.from).not.toHaveBeenCalledWith('generations');
    expect(client.rpc).toHaveBeenNthCalledWith(2, 'finish_generation_completion_job', {
      p_id: 'job-1',
      p_locked_by: 'worker-1',
      p_succeeded: true,
      p_error: null,
      p_retry_delay_seconds: 60,
    });
  });

  it('does not re-sync callback generation ids that are already settled', async () => {
    const webhookPayload = {
      data: { taskId: 'task-1', state: 'success' },
      magicbooklet: { callbackGenerationId: 'generation-1' },
    };
    const client = createCompletionWorkerClient([
      {
        data: [{
          id: 'job-1',
          prediction_id: 'task-1',
          payload: webhookPayload,
          status: 'processing',
          attempt_count: 1,
          locked_by: 'worker-1',
        }],
        error: null,
      },
      { data: 'pending', error: null },
    ]);
    vi.mocked(syncGenerationStatusByPredictionId)
      .mockResolvedValueOnce({ found: false, status: 'missing', generation: null });
    vi.mocked(attachGenerationProviderTask).mockResolvedValueOnce('already_settled');

    await expect(processGenerationCompletionJobs({
      supabase: client as never,
      creditSupabase: client as never,
      lockedBy: 'worker-1',
      limit: 5,
    })).resolves.toEqual({
      claimed: 1,
      completed: 0,
      retried: 1,
      failed: 0,
    });

    expect(syncGenerationStatusByPredictionId).toHaveBeenCalledTimes(1);
    expect(attachGenerationProviderTask).toHaveBeenCalledWith(client, {
      generationId: 'generation-1',
      predictionId: 'task-1',
    });
    expect(client.rpc).toHaveBeenNthCalledWith(2, 'finish_generation_completion_job', {
      p_id: 'job-1',
      p_locked_by: 'worker-1',
      p_succeeded: false,
      p_error: 'Generation row not found for provider task.',
      p_retry_delay_seconds: 60,
    });
  });

  it('backs off non-terminal completion retries using the claimed attempt count', async () => {
    const webhookPayload = { data: { taskId: 'task-1', state: 'generating' } };
    const client = createRpcClient([
      {
        data: [{
          id: 'job-1',
          prediction_id: 'task-1',
          payload: webhookPayload,
          status: 'processing',
          attempt_count: 3,
          locked_by: 'worker-1',
        }],
        error: null,
      },
      { data: 'pending', error: null },
    ]);
    vi.mocked(syncGenerationStatusByPredictionId).mockResolvedValue({
      found: true,
      status: 'processing',
      generation: {
        id: 'generation-1',
        user_id: 'user-1',
        prediction_id: 'task-1',
        status: 'processing',
        output_url: null,
        category: 'image',
        model: 'nanobanana',
        workflow_settings: null,
        created_at: '2026-06-21T10:00:00.000Z',
        completed_at: null,
      },
    });

    await expect(processGenerationCompletionJobs({
      supabase: client as never,
      creditSupabase: client as never,
      lockedBy: 'worker-1',
      limit: 5,
    })).resolves.toEqual({
      claimed: 1,
      completed: 0,
      retried: 1,
      failed: 0,
    });

    expect(client.rpc).toHaveBeenNthCalledWith(2, 'finish_generation_completion_job', {
      p_id: 'job-1',
      p_locked_by: 'worker-1',
      p_succeeded: false,
      p_error: 'Generation is still processing.',
      p_retry_delay_seconds: 240,
    });
    expect(settleGenerationFailed).not.toHaveBeenCalled();
  });

  it('settles and refunds the generation before marking an exhausted completion job failed', async () => {
    const webhookPayload = { data: { taskId: 'task-1', state: 'generating' } };
    const supabase = createRpcClient([
      {
        data: [{
          id: 'job-1',
          prediction_id: 'task-1',
          payload: webhookPayload,
          status: 'processing',
          attempt_count: 5,
          locked_by: 'worker-1',
        }],
        error: null,
      },
      { data: 'failed', error: null },
    ]);
    const creditSupabase = createRpcClient([]);
    vi.mocked(syncGenerationStatusByPredictionId).mockResolvedValue({
      found: true,
      status: 'processing',
      generation: {
        id: 'generation-1',
        user_id: 'user-1',
        prediction_id: 'task-1',
        status: 'processing',
        output_url: null,
        category: 'image',
        model: 'nanobanana',
        workflow_settings: null,
        created_at: '2026-06-21T10:00:00.000Z',
        completed_at: null,
      },
    });

    await expect(processGenerationCompletionJobs({
      supabase: supabase as never,
      creditSupabase: creditSupabase as never,
      lockedBy: 'worker-1',
      limit: 5,
    })).resolves.toEqual({
      claimed: 1,
      completed: 0,
      retried: 0,
      failed: 1,
    });

    expect(settleGenerationFailed).toHaveBeenCalledWith(creditSupabase, 'task-1');
    expect(supabase.rpc).toHaveBeenNthCalledWith(2, 'finish_generation_completion_job', {
      p_id: 'job-1',
      p_locked_by: 'worker-1',
      p_succeeded: false,
      p_error: 'Generation is still processing.',
      p_retry_delay_seconds: 900,
    });
  });

  it('processes completion batches with bounded parallelism', async () => {
    const jobs = Array.from({ length: 7 }, (_, index) => ({
      id: `job-${index + 1}`,
      prediction_id: `task-${index + 1}`,
      payload: { data: { taskId: `task-${index + 1}`, state: 'success' } },
      status: 'processing',
      attempt_count: 1,
      next_attempt_at: '2026-06-21T10:00:00.000Z',
      locked_at: '2026-06-21T10:00:00.000Z',
      locked_by: 'worker-1',
      last_error: null,
      created_at: '2026-06-21T10:00:00.000Z',
      updated_at: '2026-06-21T10:00:00.000Z',
      completed_at: null,
    }));
    const client = {
      rpc: vi.fn(async (functionName: string) => functionName === 'claim_generation_completion_jobs'
        ? { data: jobs, error: null }
        : { data: 'succeeded', error: null }),
    };
    let active = 0;
    let peakActive = 0;
    vi.mocked(syncGenerationStatusByPredictionId).mockImplementation(async ({ predictionId }) => {
      active += 1;
      peakActive = Math.max(peakActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return {
        found: true,
        status: 'succeeded',
        generation: {
          id: `generation-${predictionId}`,
          user_id: 'user-1',
          prediction_id: predictionId,
          status: 'succeeded',
          output_url: null,
          category: 'image',
          model: 'nanobanana',
          workflow_settings: null,
          created_at: '2026-06-21T10:00:00.000Z',
          completed_at: '2026-06-21T10:01:00.000Z',
        },
      };
    });

    await expect(processGenerationCompletionJobs({
      supabase: client as never,
      creditSupabase: client as never,
      lockedBy: 'worker-1',
      limit: jobs.length,
    })).resolves.toEqual({
      claimed: 7,
      completed: 7,
      retried: 0,
      failed: 0,
    });

    expect(peakActive).toBe(4);
    expect(syncGenerationStatusByPredictionId).toHaveBeenCalledTimes(7);
  });
});
