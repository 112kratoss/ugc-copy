import { describe, expect, it, vi } from 'vitest';

import { syncGenerationStatusByPredictionId } from '@/lib/generation-services';
import {
  claimGenerationCompletionJobs,
  enqueueGenerationCompletionJob,
  finishGenerationCompletionJob,
  processGenerationCompletionJobs,
  pruneGenerationCompletionJobs,
} from '@/lib/generation-completion-jobs';

vi.mock('@/lib/generation-services', () => ({
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

describe('generation completion jobs', () => {
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

  it('throws database errors instead of silently dropping completion work', async () => {
    const client = createRpcClient([{ data: null, error: new Error('database unavailable') }]);

    await expect(enqueueGenerationCompletionJob(client, {
      predictionId: 'task-1',
      payload: {},
    })).rejects.toThrow('database unavailable');
  });

  it('marks claimed jobs complete after a terminal generation sync', async () => {
    const client = createRpcClient([
      {
        data: [{
          id: 'job-1',
          prediction_id: 'task-1',
          payload: {},
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
});
