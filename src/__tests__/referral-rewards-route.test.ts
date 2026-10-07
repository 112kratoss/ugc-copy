import { afterEach, describe, expect, it, vi } from 'vitest';

type LockMockResult =
  | { acquired: true; value: unknown }
  | { acquired: false; reason: 'already_running' };

const reconciliationState = vi.hoisted(() => ({
  hasWork: vi.fn(async () => true),
  reconcile: vi.fn(async () => ({
    processed: 3,
    settled: 2,
    failed: 0,
    failures: [],
    notificationDelivery: { processed: 2, delivered: 2, failed: 0 },
  })),
}));

const lockState = vi.hoisted(() => ({
  withLock: vi.fn(async (_client, _options, task: () => Promise<unknown>): Promise<LockMockResult> => ({
    acquired: true,
    value: await task(),
  })),
}));

const jobRunState = vi.hoisted(() => ({
  finish: vi.fn(async () => undefined),
  prune: vi.fn(async () => 0),
  start: vi.fn(async (_client, options: {
    name: string;
    route: string;
    requestId: string;
    lockOwner: string;
    startedAtMs: number;
  }) => ({ id: 'run-referral-1', ...options })),
}));

vi.mock('@/lib/referral-reward-reconciliation', async () => ({
  ...await vi.importActual<typeof import('@/lib/referral-reward-reconciliation')>('@/lib/referral-reward-reconciliation'),
  REFERRAL_REWARD_RECONCILIATION_BATCH_LIMIT: 100,
  hasUnsettledReferralPurchaseTransactions: reconciliationState.hasWork,
  reconcileReferralPurchaseRewards: reconciliationState.reconcile,
}));

vi.mock('@/lib/backend-job-lock', () => ({
  withBackendJobLock: lockState.withLock,
}));

vi.mock('@/lib/backend-job-runs', () => ({
  finishBackendJobRun: jobRunState.finish,
  maybePruneBackendJobRuns: jobRunState.prune,
  startBackendJobRun: jobRunState.start,
}));

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => ({ service: true }),
}));

describe('referral reward reconciliation cron', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    reconciliationState.hasWork.mockReset();
    reconciliationState.hasWork.mockResolvedValue(true);
    reconciliationState.reconcile.mockReset();
    reconciliationState.reconcile.mockResolvedValue({
      processed: 3,
      settled: 2,
      failed: 0,
      failures: [],
    notificationDelivery: { processed: 2, delivered: 2, failed: 0 },
    });
    lockState.withLock.mockReset();
    lockState.withLock.mockImplementation(async (_client, _options, task: () => Promise<unknown>): Promise<LockMockResult> => ({
      acquired: true,
      value: await task(),
    }));
    jobRunState.finish.mockClear();
    jobRunState.prune.mockClear();
    jobRunState.start.mockClear();
  });

  it('rejects unauthorized calls before checking for work', async () => {
    vi.stubEnv('CRON_SECRET', 'secret');
    const { GET } = await import('@/app/api/cron/referral-rewards/route');

    const response = await GET(new Request('http://localhost/api/cron/referral-rewards', {
      headers: { 'x-request-id': 'referral-reject-1' },
    }));

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('referral-reject-1');
    expect(jobRunState.start).not.toHaveBeenCalled();
    expect(reconciliationState.hasWork).not.toHaveBeenCalled();
  });

  it('runs a bounded successful reconciliation and records notification delivery', async () => {
    vi.stubEnv('CRON_SECRET', 'secret');
    const { GET } = await import('@/app/api/cron/referral-rewards/route');

    const response = await GET(new Request('http://localhost/api/cron/referral-rewards', {
      headers: {
        authorization: 'Bearer secret',
        'x-request-id': 'referral-run-1',
      },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      summary: {
        processed: 3,
        settled: 2,
        failed: 0,
        failures: [],
    notificationDelivery: { processed: 2, delivered: 2, failed: 0 },
      },
    });
    expect(jobRunState.start).toHaveBeenCalledWith(
      { service: true },
      expect.objectContaining({
        name: 'referral-reward-reconciliation',
        route: '/api/cron/referral-rewards',
        requestId: 'referral-run-1',
      }),
    );
    expect(lockState.withLock).toHaveBeenCalledWith(
      { service: true },
      expect.objectContaining({
        name: 'referral-reward-reconciliation',
        ttlSeconds: 840,
      }),
      expect.any(Function),
    );
    expect(reconciliationState.reconcile).toHaveBeenCalledWith(
      { service: true },
      { limit: 100 },
    );
    expect(jobRunState.finish).toHaveBeenCalledWith(
      { service: true },
      expect.objectContaining({ id: 'run-referral-1' }),
      expect.objectContaining({
        status: 'succeeded',
        summary: expect.objectContaining({ processed: 3, settled: 2, failed: 0 }),
      }),
    );
  });

  it('records a healthy no-work skip without taking the job lock', async () => {
    vi.stubEnv('CRON_SECRET', 'secret');
    reconciliationState.hasWork.mockResolvedValueOnce(false);
    const { GET } = await import('@/app/api/cron/referral-rewards/route');

    const response = await GET(new Request('http://localhost/api/cron/referral-rewards', {
      headers: { authorization: 'Bearer secret' },
    }));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      skipped: true,
      reason: 'no_unsettled_referral_rewards',
      summary: { processed: 0, settled: 0, failed: 0, failures: [] },
    });
    expect(lockState.withLock).not.toHaveBeenCalled();
    expect(reconciliationState.reconcile).not.toHaveBeenCalled();
    expect(jobRunState.finish).toHaveBeenCalledWith(
      { service: true },
      expect.objectContaining({ id: 'run-referral-1' }),
      expect.objectContaining({
        status: 'skipped',
        skipReason: 'no_unsettled_referral_rewards',
      }),
    );
  });

  it('fails the HTTP job and retains partial delivery evidence when an event is deferred', async () => {
    vi.stubEnv('CRON_SECRET', 'secret');
    const { ReferralRewardReconciliationError } = await import('@/lib/referral-reward-reconciliation');
    const summary = { processed: 0, settled: 0, failed: 0, failures: [], notificationDelivery: { processed: 2, delivered: 1, failed: 1 } };
    reconciliationState.reconcile.mockRejectedValueOnce(new ReferralRewardReconciliationError(summary));
    const { GET } = await import('@/app/api/cron/referral-rewards/route');
    const response = await GET(new Request('http://localhost/api/cron/referral-rewards', { headers: { authorization: 'Bearer secret' } }));
    expect(response.status).toBe(500);
    expect(jobRunState.finish).toHaveBeenCalledWith(
      { service: true }, expect.objectContaining({ id: 'run-referral-1' }),
      expect.objectContaining({ status: 'failed', summary }),
    );
  });

  it('fails the managed job when the work-discovery query fails', async () => {
    vi.stubEnv('CRON_SECRET', 'secret');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    reconciliationState.hasWork.mockRejectedValueOnce(new Error('database unavailable'));
    const { GET } = await import('@/app/api/cron/referral-rewards/route');

    const response = await GET(new Request('http://localhost/api/cron/referral-rewards', {
      headers: { authorization: 'Bearer secret' },
    }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'Failed to reconcile referral rewards.',
    });
    expect(jobRunState.finish).toHaveBeenCalledWith(
      { service: true },
      expect.objectContaining({ id: 'run-referral-1' }),
      expect.objectContaining({
        status: 'failed',
        errorMessage: 'database unavailable',
      }),
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(
      'referral_reward_reconciliation_failed',
    ));
  });
});
