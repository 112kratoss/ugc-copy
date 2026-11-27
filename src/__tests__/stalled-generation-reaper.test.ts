import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createMobileNotificationHistory,
  hasAnswered,
  withMobileNotificationHistory,
} from '@/__tests__/fixtures/mobile-notification-history';
import { getPublicGenerationStartFailure } from '@/lib/generation-services';
import { syncGenerationStatusByPredictionId } from '@/lib/generation-status-sync';
import {
  hasStalledGenerationWork,
  reapStalledGenerations,
  STALLED_GENERATION_GIVE_UP_AFTER_HOURS,
  STALLED_GENERATION_START_FAILURE_AFTER_MINUTES,
  STALLED_GENERATION_START_FAILURE_BATCH_LIMIT,
  STALLED_GENERATION_SYNC_AFTER_MINUTES,
  STALLED_GENERATION_SYNC_BATCH_LIMIT,
} from '@/lib/stalled-generation-reaper';

vi.mock('@/lib/generation-status-sync', () => ({
  syncGenerationStatusByPredictionId: vi.fn(),
}));

vi.mock('@/lib/completed-remix-notification', () => ({ notifyCompletedRemix: vi.fn() }));

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
  const update = vi.fn(() => builder);
  Object.assign(builder, { select, in: inFilter, eq, is, not, lt, order, limit, update });
  const from = vi.fn(() => builder);
  const rpc = vi.fn(async () => {
    const result = rpcResults.shift();
    if (!result) throw new Error('Unexpected RPC call');
    return result;
  });

  return { from, select, in: inFilter, eq, is, not, lt, order, limit, update, rpc };
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
      providerSync: { eligible: 4, reconciled: 1, stillActive: 1, abandoned: 0, skipped: 1, failed: 1, deferred: 0 },
      startFailures: { eligible: 0, settled: 0, skipped: 0, failed: 0, deferred: 0, submissionUnknown: 0 },
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
        { data: { status: 'held' }, error: null },
        { data: { status: 'failed', refunded: true }, error: null },
        { data: { status: 'held' }, error: null },
        { data: { status: 'provider_task_attached' }, error: null },
        { data: { status: 'held' }, error: null },
        { data: null, error: { message: 'rpc unavailable' } },
        { data: { status: 'held' }, error: null },
        { data: { status: 'missing' }, error: null },
      ],
    );

    await expect(reapStalledGenerations({
      supabase: client as never,
      creditSupabase: client as never,
      nowMs: NOW_MS,
    })).resolves.toEqual({
      providerSync: { eligible: 0, reconciled: 0, stillActive: 0, abandoned: 0, skipped: 0, failed: 0, deferred: 0 },
      startFailures: { eligible: 4, settled: 1, skipped: 1, failed: 2, deferred: 0, submissionUnknown: 1 },
    });

    expect(client.lt).toHaveBeenNthCalledWith(2, 'created_at', '2026-06-21T09:15:00.000Z');
    expect(client.limit).toHaveBeenNthCalledWith(2, STALLED_GENERATION_START_FAILURE_BATCH_LIMIT);
    expect(getPublicGenerationStartFailure).toHaveBeenCalledWith(expect.objectContaining({ status: 504 }));
    expect(client.rpc).toHaveBeenCalledTimes(8);
    expect(client.rpc).toHaveBeenNthCalledWith(2, 'settle_generation_start_failed', {
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
      providerSync: { eligible: 2, reconciled: 0, stillActive: 0, abandoned: 0, skipped: 0, failed: 0, deferred: 2 },
      startFailures: { eligible: 1, settled: 0, skipped: 0, failed: 0, deferred: 1, submissionUnknown: 0 },
    });

    expect(syncGenerationStatusByPredictionId).not.toHaveBeenCalled();
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('marks expired taskless starts conservatively before settlement', async () => {
    // Missing markers can follow dispatch or write failure, not just rejection.
    const client = createGenerationsClient(
      [
        { data: [], error: null },
        {
          data: [
            {
              id: 'gen-held',
              prediction_id: null,
              status: 'pending',
              created_at: '2026-06-21T08:00:00.000Z',
              submission_unknown_at: '2026-06-21T08:00:30.000Z',
            },
            {
              id: 'gen-clean',
              prediction_id: null,
              status: 'pending',
              created_at: '2026-06-21T08:05:00.000Z',
              submission_unknown_at: null,
            },
          ],
          error: null,
        },
      ],
      [
        { data: { status: 'failed', refunded: true }, error: null },
        { data: { status: 'held' }, error: null },
        { data: { status: 'failed', refunded: true }, error: null },
      ],
    );

    await expect(reapStalledGenerations({
      supabase: client as never,
      creditSupabase: client as never,
      nowMs: NOW_MS,
    })).resolves.toMatchObject({
      startFailures: { eligible: 2, settled: 2, submissionUnknown: 2 },
    });
  });

  it('routes template generations to the settlement RPC that also fails the run step', async () => {
    // settle_generation_start_failed refunds the hold but never touches
    // template_run_steps, so settling a template row through it strands the run
    // in `processing`. Previously near-unreachable because template starts
    // settled synchronously; holding ambiguous submissions makes these rows
    // ordinary, so the branch has to be right before it carries real traffic.
    const client = createGenerationsClient(
      [
        { data: [], error: null },
        {
          data: [
            {
              id: 'gen-template',
              prediction_id: null,
              status: 'pending',
              created_at: '2026-06-21T08:00:00.000Z',
              template_run_id: 'run-1',
              template_run_step_id: 'step-1',
            },
            {
              id: 'gen-direct',
              prediction_id: null,
              status: 'pending',
              created_at: '2026-06-21T08:05:00.000Z',
              template_run_id: null,
              template_run_step_id: null,
            },
          ],
          error: null,
        },
      ],
      [
        { data: { status: 'held' }, error: null },
        { data: { status: 'failed', refunded: true }, error: null },
        { data: { status: 'held' }, error: null },
        { data: { status: 'failed', refunded: true }, error: null },
      ],
    );

    await reapStalledGenerations({
      supabase: client as never,
      creditSupabase: client as never,
      nowMs: NOW_MS,
    });

    expect(client.rpc).toHaveBeenNthCalledWith(
      2,
      'settle_template_generation_start_failed',
      expect.objectContaining({ p_generation_id: 'gen-template' }),
    );
    expect(client.rpc).toHaveBeenNthCalledWith(
      4,
      'settle_generation_start_failed',
      expect.objectContaining({ p_generation_id: 'gen-direct' }),
    );
  });

  describe('telling the creator a held start was given up on', () => {
    function heldStart(overrides: Record<string, unknown> = {}) {
      return {
        id: 'gen-held',
        user_id: 'user-1',
        category: 'video',
        model: 'kling-2.6',
        prediction_id: null,
        status: 'pending',
        created_at: '2026-06-21T08:00:00.000Z',
        template_run_id: null,
        template_run_step_id: null,
        submission_unknown_at: '2026-06-21T08:00:30.000Z',
        ...overrides,
      };
    }

    /** No stalled provider tasks, then the held starts, then one settlement answer each. */
    function createHeldStartsClient(rows: unknown[], settlements: string[]) {
      return createGenerationsClient(
        [{ data: [], error: null }, { data: rows, error: null }],
        settlements.map((status) => ({ data: { status, refunded: true }, error: null })),
      );
    }

    function reap(client: ReturnType<typeof createGenerationsClient>, history: ReturnType<typeof createMobileNotificationHistory>) {
      const notified = withMobileNotificationHistory(client as never, history);
      return reapStalledGenerations({ supabase: notified, creditSupabase: notified, nowMs: NOW_MS });
    }

    it('sends the failure notification when the hold is released and the credits returned', async () => {
      const client = createHeldStartsClient([heldStart()], ['failed']);
      const history = createMobileNotificationHistory();

      await expect(reap(client, history)).resolves.toMatchObject({
        startFailures: { eligible: 1, settled: 1, failed: 0 },
      });

      expect(client.select).toHaveBeenNthCalledWith(2, expect.stringMatching(/\buser_id\b/));
      expect(client.select).toHaveBeenNthCalledWith(2, expect.stringMatching(/\bcategory\b/));
      expect(history.sent).toEqual([expect.objectContaining({
        user_id: 'user-1',
        type: 'generation_failed',
        category: 'generation',
        title: 'Your video failed',
        object_type: 'generation',
        object_id: 'gen-held',
        dedupe_key: 'generation:gen-held:failed',
      })]);
    });

    it('tells the creator of a template run step as well', async () => {
      const client = createHeldStartsClient(
        [heldStart({ id: 'gen-template', category: 'image', template_run_id: 'run-1', template_run_step_id: 'step-1' })],
        ['failed'],
      );
      const history = createMobileNotificationHistory();

      await reap(client, history);

      expect(client.rpc).toHaveBeenCalledWith(
        'settle_template_generation_start_failed',
        expect.objectContaining({ p_generation_id: 'gen-template' }),
      );
      expect(history.sent).toEqual([expect.objectContaining({
        user_id: 'user-1',
        title: 'Your image failed',
        dedupe_key: 'generation:gen-template:failed',
      })]);
    });

    it('has sent it before it moves on to the next held start', async () => {
      const client = createHeldStartsClient(
        [heldStart(), heldStart({ id: 'gen-held-2', user_id: 'user-2' })],
        ['failed', 'failed'],
      );
      const history = createMobileNotificationHistory();
      history.hold();

      const reaping = reap(client, history);

      expect(await hasAnswered(reaping)).toBe(false);
      expect(history.started).toEqual(['generation:gen-held:failed']);
      expect(client.rpc).toHaveBeenCalledTimes(1);

      history.release();
      await reaping;
      expect(history.sent.map((notification) => notification.user_id)).toEqual(['user-1', 'user-2']);
    });

    it.each([
      ['had already been failed and refunded', 'already_failed'],
      ['got its provider task after all', 'provider_task_attached'],
      ['had succeeded', 'already_succeeded'],
    ])('sends nothing for a start that %s', async (_outcome, settlement) => {
      const client = createHeldStartsClient([heldStart()], [settlement]);
      const history = createMobileNotificationHistory();

      await reap(client, history);

      expect(client.rpc).toHaveBeenCalledTimes(1);
      expect(history.started).toEqual([]);
    });
  });

  describe('rotation, the import window and the maximum age', () => {
    const HOUR = 60 * 60 * 1000;
    function activeRow(id: string, ageHours: number, overrides: Record<string, unknown> = {}) {
      return {
        id,
        prediction_id: `task-${id}`,
        status: 'processing',
        created_at: new Date(NOW_MS - ageHours * HOUR).toISOString(),
        user_id: 'user-1',
        category: 'video',
        model: 'kling-2.6',
        template_run_id: null,
        provider_sync_attempted_at: null,
        ...overrides,
      };
    }

    it('takes the least recently tried rows first and leaves generations whose provider finished to the import pipeline', async () => {
      const client = createGenerationsClient([{ data: [], error: null }, { data: [], error: null }]);

      await reapStalledGenerations({ supabase: client as never, creditSupabase: client as never, nowMs: NOW_MS });

      expect(client.select).toHaveBeenNthCalledWith(1, expect.stringContaining('generation_output_import_jobs(id)'));
      expect(client.is).toHaveBeenCalledWith('generation_output_import_jobs', null);
      expect(client.order).toHaveBeenNthCalledWith(1, 'provider_sync_attempted_at', { ascending: true, nullsFirst: true });
      expect(client.order).toHaveBeenNthCalledWith(2, 'created_at', { ascending: true });
    });

    it('records each attempt before asking the provider, so a row that never resolves moves to the back', async () => {
      const client = createGenerationsClient([
        { data: [activeRow('gen-1', 2)], error: null },
        { data: [], error: null },
      ]);
      vi.mocked(syncGenerationStatusByPredictionId).mockRejectedValueOnce(new Error('provider exploded'));

      await reapStalledGenerations({ supabase: client as never, creditSupabase: client as never, nowMs: NOW_MS });

      expect(client.update).toHaveBeenCalledExactlyOnceWith({ provider_sync_attempted_at: '2026-06-21T10:00:00.000Z' });
      expect(client.eq).toHaveBeenCalledWith('id', 'gen-1');
    });

    it('fails and refunds a row the provider still reports as running after 24 hours, and tells the creator', async () => {
      const client = createGenerationsClient(
        [
          { data: [activeRow('gen-old', 25), activeRow('gen-young', 23)], error: null },
          { data: [], error: null },
        ],
        [{ data: { status: 'failed', refunded: true }, error: null }],
      );
      vi.mocked(syncGenerationStatusByPredictionId)
        .mockResolvedValueOnce(syncedGeneration('task-gen-old', 'processing'))
        .mockResolvedValueOnce(syncedGeneration('task-gen-young', 'processing'));
      const history = createMobileNotificationHistory();
      const notified = withMobileNotificationHistory(client as never, history);

      await expect(reapStalledGenerations({ supabase: notified, creditSupabase: notified, nowMs: NOW_MS }))
        .resolves.toMatchObject({
          providerSync: { eligible: 2, reconciled: 0, stillActive: 1, abandoned: 1, failed: 0 },
        });

      expect(STALLED_GENERATION_GIVE_UP_AFTER_HOURS).toBe(24);
      expect(client.rpc).toHaveBeenCalledExactlyOnceWith('settle_generation_failed', {
        p_prediction_id: 'task-gen-old',
        p_completed_at: null,
        p_error_message: expect.stringContaining('never reported a final result'),
      });
      expect(history.sent).toEqual([expect.objectContaining({
        user_id: 'user-1',
        type: 'generation_failed',
        dedupe_key: 'generation:gen-old:failed',
      })]);
    });

    it('gives up on a row past the maximum age whose task the provider no longer knows', async () => {
      const client = createGenerationsClient(
        [{ data: [activeRow('gen-old', 30)], error: null }, { data: [], error: null }],
        [{ data: { status: 'failed', refunded: true }, error: null }],
      );
      vi.mocked(syncGenerationStatusByPredictionId).mockRejectedValueOnce(new Error('recordInfo is null'));

      await expect(reapStalledGenerations({ supabase: client as never, creditSupabase: client as never, nowMs: NOW_MS }))
        .resolves.toMatchObject({ providerSync: { abandoned: 1, failed: 0 } });
      expect(client.rpc).toHaveBeenCalledWith('settle_generation_failed', expect.objectContaining({
        p_prediction_id: 'task-gen-old',
        p_error_message: expect.stringContaining('recordInfo is null'),
      }));
    });

    it('sends nothing when the give-up finds the render succeeded after all', async () => {
      const client = createGenerationsClient(
        [{ data: [activeRow('gen-old', 30)], error: null }, { data: [], error: null }],
        [{ data: { status: 'already_succeeded' }, error: null }],
      );
      vi.mocked(syncGenerationStatusByPredictionId).mockResolvedValueOnce(syncedGeneration('task-gen-old', 'waiting'));
      const history = createMobileNotificationHistory();
      const notified = withMobileNotificationHistory(client as never, history);

      await expect(reapStalledGenerations({ supabase: notified, creditSupabase: notified, nowMs: NOW_MS }))
        .resolves.toMatchObject({ providerSync: { abandoned: 0, skipped: 1 } });
      expect(history.started).toEqual([]);
    });

    it('stops starting rows at the run deadline it is given, whatever its own budget', async () => {
      const client = createGenerationsClient([
        { data: [activeRow('gen-1', 2)], error: null },
        { data: [activeRow('gen-a', 2, { status: 'pending', prediction_id: null })], error: null },
      ]);

      await expect(reapStalledGenerations({
        supabase: client as never,
        creditSupabase: client as never,
        nowMs: NOW_MS,
        timeBudgetMs: 120_000,
        deadlineMs: Date.now() - 1,
      })).resolves.toMatchObject({
        providerSync: { eligible: 1, deferred: 1 },
        startFailures: { eligible: 1, deferred: 1 },
      });
      expect(syncGenerationStatusByPredictionId).not.toHaveBeenCalled();
      expect(client.update).not.toHaveBeenCalled();
    });
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
