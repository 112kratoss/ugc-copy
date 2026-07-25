import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getPublicGenerationStartFailure } from '@/lib/generation-services';
import { syncGenerationStatusByPredictionId } from '@/lib/generation-status-sync';
import {
  hasStalledGenerationWork,
  reapStalledGenerations,
  STALLED_GENERATION_START_FAILURE_AFTER_MINUTES,
  STALLED_GENERATION_START_FAILURE_BATCH_LIMIT,
  STALLED_GENERATION_SYNC_AFTER_MINUTES,
  STALLED_GENERATION_SYNC_BATCH_LIMIT,
} from '@/lib/stalled-generation-reaper';

vi.mock('@/lib/generation-status-sync', () => ({
  syncGenerationStatusByPredictionId: vi.fn(),
}));

vi.mock('@/lib/generation-services', () => ({
  getPublicGenerationStartFailure: vi.fn(() => ({
    code: 'provider_unavailable',
    message: 'The generation provider is temporarily unavailable. Please retry this step shortly.',
  })),
}));

type QueryResult = { data: unknown; error: Error | { message?: string } | null };

function createGenerationsClient(
  queryResults: QueryResult[],
  rpcResults: QueryResult[] = [],
) {
  const limit = vi.fn(async () => {
    const result = queryResults.shift();
    if (!result) throw new Error('Unexpected generations query');
    return result;
  });
  const builder: Record<string, unknown> = {};
  const select = vi.fn(() => builder);
  const inFilter = vi.fn(() => builder);
  const eq = vi.fn(() => builder);
  const is = vi.fn(() => builder);
  const not = vi.fn(() => builder);
  const lt = vi.fn(() => builder);
  const order = vi.fn(() => builder);
  Object.assign(builder, { select, in: inFilter, eq, is, not, lt, order, limit });
  const from = vi.fn(() => builder);
  const rpc = vi.fn(async () => {
    const result = rpcResults.shift();
    if (!result) throw new Error('Unexpected RPC call');
    return result;
  });

  return { from, select, in: inFilter, eq, is, not, lt, order, limit, rpc };
}

function syncedGeneration(predictionId: string, status: 'succeeded' | 'failed' | 'processing' | 'waiting') {
  return {
    found: true as const,
    status,
    generation: {
      id: `generation-${predictionId}`,
      user_id: 'user-1',
      prediction_id: predictionId,
      status,
      output_url: null,
      category: 'image',
      model: 'nanobanana',
      workflow_settings: null,
      created_at: '2026-06-21T09:00:00.000Z',
      completed_at: status === 'succeeded' || status === 'failed' ? '2026-06-21T10:00:00.000Z' : null,
    },
  };
}

const NOW_MS = Date.UTC(2026, 5, 21, 10, 0, 0);

describe('stalled generation reaper', () => {
  beforeEach(() => {
    vi.mocked(syncGenerationStatusByPredictionId).mockReset();
    vi.mocked(getPublicGenerationStartFailure).mockClear();
  });

  it('uses bounded thirty and forty-five minute stall windows', () => {
    expect(STALLED_GENERATION_SYNC_AFTER_MINUTES).toBe(30);
    expect(STALLED_GENERATION_START_FAILURE_AFTER_MINUTES).toBe(45);
    expect(STALLED_GENERATION_SYNC_BATCH_LIMIT).toBe(10);
    expect(STALLED_GENERATION_START_FAILURE_BATCH_LIMIT).toBe(10);
  });

  it('detects stalled provider-task generations with an indexed one-row probe', async () => {
    const client = createGenerationsClient([{ data: [{ id: 'gen-1' }], error: null }]);

    await expect(hasStalledGenerationWork(client as never, { nowMs: NOW_MS })).resolves.toBe(true);

    expect(client.from).toHaveBeenCalledWith('generations');
    expect(client.in).toHaveBeenCalledWith('status', ['waiting', 'processing']);
    expect(client.not).toHaveBeenCalledWith('prediction_id', 'is', null);
    expect(client.lt).toHaveBeenCalledWith('created_at', '2026-06-21T09:30:00.000Z');
    expect(client.limit).toHaveBeenCalledWith(1);
    expect(client.eq).not.toHaveBeenCalled();
  });

  it('falls back to the stalled pending-start probe when no active work is stalled', async () => {
    const client = createGenerationsClient([
      { data: [], error: null },
      { data: [{ id: 'gen-2' }], error: null },
    ]);

    await expect(hasStalledGenerationWork(client as never, { nowMs: NOW_MS })).resolves.toBe(true);

    expect(client.eq).toHaveBeenCalledWith('status', 'pending');
    expect(client.is).toHaveBeenCalledWith('prediction_id', null);
    expect(client.lt).toHaveBeenNthCalledWith(2, 'created_at', '2026-06-21T09:15:00.000Z');
  });

  it('reports no stalled work when both probes come back empty', async () => {
    const client = createGenerationsClient([
      { data: [], error: null },
      { data: [], error: null },
    ]);

    await expect(hasStalledGenerationWork(client as never, { nowMs: NOW_MS })).resolves.toBe(false);
  });

  it('rejects invalid probe timestamps', async () => {
    const client = createGenerationsClient([]);

    await expect(hasStalledGenerationWork(client as never, { nowMs: Number.NaN }))
      .rejects.toThrow('valid timestamp');
  });

  it('reconciles stalled active generations oldest first without letting one bad row stop the batch', async () => {
    const client = createGenerationsClient([
      {
        data: [
          { id: 'gen-1', prediction_id: 'task-1', status: 'processing', created_at: '2026-06-21T08:00:00.000Z' },
          { id: 'gen-2', prediction_id: 'task-2', status: 'waiting', created_at: '2026-06-21T08:10:00.000Z' },
          { id: 'gen-3', prediction_id: 'task-3', status: 'processing', created_at: '2026-06-21T08:20:00.000Z' },
          { id: 'gen-4', prediction_id: null, status: 'processing', created_at: '2026-06-21T08:30:00.000Z' },
        ],
        error: null,
      },
      { data: [], error: null },
    ]);
    vi.mocked(syncGenerationStatusByPredictionId)
      .mockResolvedValueOnce(syncedGeneration('task-1', 'succeeded'))
      .mockRejectedValueOnce(new Error('provider exploded'))
      .mockResolvedValueOnce(syncedGeneration('task-3', 'processing'));

    await expect(reapStalledGenerations({
      supabase: client as never,
      creditSupabase: client as never,
      nowMs: NOW_MS,
    })).resolves.toEqual({
      providerSync: { eligible: 4, reconciled: 1, stillActive: 1, skipped: 1, failed: 1, deferred: 0 },
      startFailures: { eligible: 0, settled: 0, skipped: 0, failed: 0, deferred: 0 },
    });

    expect(client.lt).toHaveBeenNthCalledWith(1, 'created_at', '2026-06-21T09:30:00.000Z');
    expect(client.order).toHaveBeenCalledWith('created_at', { ascending: true });
    expect(client.limit).toHaveBeenNthCalledWith(1, STALLED_GENERATION_SYNC_BATCH_LIMIT);
    expect(syncGenerationStatusByPredictionId).toHaveBeenCalledTimes(3);
    expect(syncGenerationStatusByPredictionId).toHaveBeenNthCalledWith(1, {
      supabase: client,
      creditSupabase: client,
      predictionId: 'task-1',
    });
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('settles stalled pending generations through the idempotent start-failure settlement RPC', async () => {
    const client = createGenerationsClient(
      [
        { data: [], error: null },
        {
          data: [
            { id: 'gen-a', prediction_id: null, status: 'pending', created_at: '2026-06-21T08:00:00.000Z' },
            { id: 'gen-b', prediction_id: null, status: 'pending', created_at: '2026-06-21T08:05:00.000Z' },
            { id: 'gen-c', prediction_id: null, status: 'pending', created_at: '2026-06-21T08:10:00.000Z' },
            { id: 'gen-d', prediction_id: null, status: 'pending', created_at: '2026-06-21T08:15:00.000Z' },
          ],
          error: null,
        },
      ],
      [
        { data: { status: 'failed', refunded: true }, error: null },
        { data: { status: 'provider_task_attached' }, error: null },
        { data: null, error: { message: 'rpc unavailable' } },
        { data: { status: 'missing' }, error: null },
      ],
    );

    await expect(reapStalledGenerations({
      supabase: client as never,
      creditSupabase: client as never,
      nowMs: NOW_MS,
    })).resolves.toEqual({
      providerSync: { eligible: 0, reconciled: 0, stillActive: 0, skipped: 0, failed: 0, deferred: 0 },
      startFailures: { eligible: 4, settled: 1, skipped: 1, failed: 2, deferred: 0 },
    });

    expect(client.lt).toHaveBeenNthCalledWith(2, 'created_at', '2026-06-21T09:15:00.000Z');
    expect(client.limit).toHaveBeenNthCalledWith(2, STALLED_GENERATION_START_FAILURE_BATCH_LIMIT);
    expect(getPublicGenerationStartFailure).toHaveBeenCalledWith(expect.objectContaining({ status: 504 }));
    expect(client.rpc).toHaveBeenCalledTimes(4);
    expect(client.rpc).toHaveBeenNthCalledWith(1, 'settle_generation_start_failed', {
      p_generation_id: 'gen-a',
      p_error_message: 'The generation provider is temporarily unavailable. Please retry this step shortly.',
    });
    expect(syncGenerationStatusByPredictionId).not.toHaveBeenCalled();
  });

  it('defers remaining rows once the in-run time budget is exhausted', async () => {
    const client = createGenerationsClient([
      {
        data: [
          { id: 'gen-1', prediction_id: 'task-1', status: 'processing', created_at: '2026-06-21T08:00:00.000Z' },
          { id: 'gen-2', prediction_id: 'task-2', status: 'processing', created_at: '2026-06-21T08:05:00.000Z' },
        ],
        error: null,
      },
      {
        data: [
          { id: 'gen-a', prediction_id: null, status: 'pending', created_at: '2026-06-21T08:00:00.000Z' },
        ],
        error: null,
      },
    ]);

    await expect(reapStalledGenerations({
      supabase: client as never,
      creditSupabase: client as never,
      nowMs: NOW_MS,
      timeBudgetMs: 0,
    })).resolves.toEqual({
      providerSync: { eligible: 2, reconciled: 0, stillActive: 0, skipped: 0, failed: 0, deferred: 2 },
      startFailures: { eligible: 1, settled: 0, skipped: 0, failed: 0, deferred: 1 },
    });

    expect(syncGenerationStatusByPredictionId).not.toHaveBeenCalled();
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('propagates batch query failures so the job-run ledger records the error', async () => {
    const client = createGenerationsClient([
      { data: null, error: new Error('database unavailable') },
    ]);

    await expect(reapStalledGenerations({
      supabase: client as never,
      creditSupabase: client as never,
      nowMs: NOW_MS,
    })).rejects.toThrow('database unavailable');
  });

  it('rejects invalid batch limits and time budgets', async () => {
    const client = createGenerationsClient([]);

    await expect(reapStalledGenerations({
      supabase: client as never,
      creditSupabase: client as never,
      nowMs: NOW_MS,
      syncLimit: 0,
    })).rejects.toThrow('positive integer');
    await expect(reapStalledGenerations({
      supabase: client as never,
      creditSupabase: client as never,
      nowMs: NOW_MS,
      startFailureLimit: 2.5,
    })).rejects.toThrow('positive integer');
    await expect(reapStalledGenerations({
      supabase: client as never,
      creditSupabase: client as never,
      nowMs: NOW_MS,
      timeBudgetMs: -1,
    })).rejects.toThrow('non-negative');
  });
});
