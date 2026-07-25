import { describe, expect, it } from 'vitest';

import { pruneOperationalBackendData } from '@/lib/operational-data-retention';

type RpcCall = { fn: string; args: Record<string, unknown> };

function createClient(result: { data?: unknown; error?: unknown }) {
  const calls: RpcCall[] = [];
  return {
    calls,
    client: {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        return { data: result.data ?? null, error: result.error ?? null };
      },
    },
  };
}

describe('operational data retention', () => {
  it('calls the bounded retention RPC and maps its summary', async () => {
    const { client, calls } = createClient({
      data: {
        job_runs_deleted: 4200,
        rate_limits_deleted: 12,
        completion_jobs_deleted: 3,
        provider_events_deleted: 90,
        provider_checks_deleted: 7,
        total_deleted: 4312,
        batch_limit_reached: false,
        pruned_at: '2026-07-25T00:50:00.000Z',
      },
    });

    const summary = await pruneOperationalBackendData(client);

    expect(calls[0].fn).toBe('prune_operational_backend_data');
    expect(summary).toEqual({
      jobRunsDeleted: 4200,
      rateLimitsDeleted: 12,
      completionJobsDeleted: 3,
      providerEventsDeleted: 90,
      providerChecksDeleted: 7,
      totalDeleted: 4312,
      batchLimitReached: false,
    });
  });

  it('passes an explicit sweep time so the job run and the deletes agree', async () => {
    const { client, calls } = createClient({ data: { total_deleted: 0 } });

    await pruneOperationalBackendData(client, { now: new Date('2026-07-25T00:50:00.000Z') });

    expect(calls[0].args.p_now).toBe('2026-07-25T00:50:00.000Z');
  });

  it('omits optional arguments so the database defaults stay authoritative', async () => {
    const { client, calls } = createClient({ data: { total_deleted: 0 } });

    await pruneOperationalBackendData(client);

    expect(calls[0].args).not.toHaveProperty('p_now');
    expect(calls[0].args).not.toHaveProperty('p_max_deletes_per_table');
  });

  it('forwards an explicit batch cap when one is given', async () => {
    const { client, calls } = createClient({ data: { total_deleted: 0 } });

    await pruneOperationalBackendData(client, { maxDeletesPerTable: 100 });

    expect(calls[0].args.p_max_deletes_per_table).toBe(100);
  });

  it('surfaces a backlog so the next scheduled run is known to have work', async () => {
    const { client } = createClient({
      data: { job_runs_deleted: 5000, total_deleted: 5000, batch_limit_reached: true },
    });

    const summary = await pruneOperationalBackendData(client);

    expect(summary.batchLimitReached).toBe(true);
  });

  it('treats a missing or malformed count as zero rather than NaN', async () => {
    const { client } = createClient({ data: { job_runs_deleted: 'lots' } });

    const summary = await pruneOperationalBackendData(client);

    expect(summary.jobRunsDeleted).toBe(0);
    expect(summary.totalDeleted).toBe(0);
  });

  it('throws when the RPC fails so the job records a failure instead of a silent no-op', async () => {
    const { client } = createClient({ error: new Error('permission denied') });

    await expect(pruneOperationalBackendData(client)).rejects.toThrow('permission denied');
  });
});
