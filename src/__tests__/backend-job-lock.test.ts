import { describe, expect, it, vi } from 'vitest';

import { withBackendJobLock } from '@/lib/backend-job-lock';

function createRpcClient(results: Array<{ data: unknown; error: Error | null }>) {
  return {
    rpc: vi.fn(async () => {
      const result = results.shift();
      if (!result) throw new Error('Unexpected RPC call');
      return result;
    }),
  };
}

describe('withBackendJobLock', () => {
  it('runs the task after acquiring the Supabase-backed lock and releases it', async () => {
    const client = createRpcClient([
      { data: true, error: null },
      { data: true, error: null },
    ]);
    const task = vi.fn(async () => 'repaired');

    const result = await withBackendJobLock(client, {
      name: 'media-preview-repair',
      ttlSeconds: 840,
      owner: 'cron-request-1',
    }, task);

    expect(result).toEqual({ acquired: true, value: 'repaired' });
    expect(task).toHaveBeenCalledOnce();
    expect(client.rpc).toHaveBeenNthCalledWith(1, 'try_acquire_backend_job_lock', {
      p_name: 'media-preview-repair',
      p_ttl_seconds: 840,
      p_locked_by: 'cron-request-1',
    });
    expect(client.rpc).toHaveBeenNthCalledWith(2, 'release_backend_job_lock', {
      p_name: 'media-preview-repair',
      p_locked_by: 'cron-request-1',
    });
  });

  it('skips the task when another run already owns the lock', async () => {
    const client = createRpcClient([{ data: false, error: null }]);
    const task = vi.fn(async () => 'repaired');

    const result = await withBackendJobLock(client, {
      name: 'media-preview-repair',
      ttlSeconds: 840,
      owner: 'cron-request-2',
    }, task);

    expect(result).toEqual({ acquired: false, reason: 'already_running' });
    expect(task).not.toHaveBeenCalled();
    expect(client.rpc).toHaveBeenCalledOnce();
  });

  it('still releases the lock when the task fails', async () => {
    const client = createRpcClient([
      { data: true, error: null },
      { data: true, error: null },
    ]);
    const taskError = new Error('preview service failed');

    await expect(withBackendJobLock(client, {
      name: 'media-preview-repair',
      ttlSeconds: 840,
      owner: 'cron-request-3',
    }, async () => {
      throw taskError;
    })).rejects.toThrow(taskError);

    expect(client.rpc).toHaveBeenNthCalledWith(2, 'release_backend_job_lock', {
      p_name: 'media-preview-repair',
      p_locked_by: 'cron-request-3',
    });
  });
});
