import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createServiceClient: vi.fn(),
  runAccountDeletionResweepsBackendJob: vi.fn(),
  runBackendAlertDeliveryJob: vi.fn(),
  runFeedMaintenanceBackendJob: vi.fn(),
  runGenerationCompletionsBackendJob: vi.fn(),
  runMediaPreviewRepairBackendJob: vi.fn(),
  runMobilePushReceiptsBackendJob: vi.fn(),
  runReferralRewardReconciliationBackendJob: vi.fn(),
  runWorkflowRunStepsBackendJob: vi.fn(),
}));

function deferredResult<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return { promise, resolve };
}

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: (...args: unknown[]) => mocks.createServiceClient(...args),
}));

vi.mock('@/lib/backend-job-executions', async () => {
  const actual = await vi.importActual<typeof import('@/lib/backend-job-executions')>(
    '@/lib/backend-job-executions',
  );

  return {
    ...actual,
    runAccountDeletionResweepsBackendJob: (...args: unknown[]) => (
      mocks.runAccountDeletionResweepsBackendJob(...args)
    ),
    runBackendAlertDeliveryJob: (...args: unknown[]) => (
      mocks.runBackendAlertDeliveryJob(...args)
    ),
    runFeedMaintenanceBackendJob: (...args: unknown[]) => (
      mocks.runFeedMaintenanceBackendJob(...args)
    ),
    runGenerationCompletionsBackendJob: (...args: unknown[]) => (
      mocks.runGenerationCompletionsBackendJob(...args)
    ),
    runMediaPreviewRepairBackendJob: (...args: unknown[]) => (
      mocks.runMediaPreviewRepairBackendJob(...args)
    ),
    runMobilePushReceiptsBackendJob: (...args: unknown[]) => (
      mocks.runMobilePushReceiptsBackendJob(...args)
    ),
    runReferralRewardReconciliationBackendJob: (...args: unknown[]) => (
      mocks.runReferralRewardReconciliationBackendJob(...args)
    ),
    runWorkflowRunStepsBackendJob: (...args: unknown[]) => (
      mocks.runWorkflowRunStepsBackendJob(...args)
    ),
  };
});

describe('/api/cron/backend-jobs route', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-22T10:00:00.000Z'));
    vi.stubEnv('CRON_SECRET', 'secret-123');
    mocks.createServiceClient.mockReset();
    mocks.createServiceClient.mockReturnValue({ service: 'supabase' });
    mocks.runAccountDeletionResweepsBackendJob.mockReset();
    mocks.runAccountDeletionResweepsBackendJob.mockResolvedValue({
      success: true,
      job: 'account-deletion-resweeps',
      route: '/api/cron/account-deletion-resweeps',
      status: 'skipped',
      skipped: true,
      reason: 'no_due_account_deletion_cleanup',
    });
    mocks.runBackendAlertDeliveryJob.mockReset();
    mocks.runBackendAlertDeliveryJob.mockResolvedValue({
      success: true,
      job: 'backend-alert-delivery',
      route: '/api/cron/backend-alert-delivery',
      status: 'skipped',
      skipped: true,
      reason: 'alert_delivery_not_configured',
      summary: { configured: false },
    });
    mocks.runFeedMaintenanceBackendJob.mockReset();
    mocks.runFeedMaintenanceBackendJob.mockResolvedValue({
      success: true,
      job: 'feed-maintenance',
      route: '/api/cron/feed-maintenance',
      status: 'succeeded',
      summary: {
        postStatsRefreshed: 1,
        userInterestProfilesRefreshed: 1,
        retention: { skipped: false },
      },
    });
    mocks.runGenerationCompletionsBackendJob.mockReset();
    mocks.runGenerationCompletionsBackendJob.mockResolvedValue({
      success: true,
      job: 'generation-completions',
      route: '/api/cron/generation-completions',
      status: 'succeeded',
      summary: { completed: 1 },
    });
    mocks.runMediaPreviewRepairBackendJob.mockReset();
    mocks.runMediaPreviewRepairBackendJob.mockResolvedValue({
      success: true,
      job: 'media-preview-repair',
      route: '/api/cron/media-preview-repair',
      status: 'succeeded',
      summary: { completed: 1 },
    });
    mocks.runMobilePushReceiptsBackendJob.mockReset();
    mocks.runMobilePushReceiptsBackendJob.mockResolvedValue({
      success: true,
      job: 'mobile-push-receipts',
      route: '/api/cron/mobile-push-receipts',
      status: 'succeeded',
      summary: { updatedCount: 1 },
    });
    mocks.runReferralRewardReconciliationBackendJob.mockReset();
    mocks.runReferralRewardReconciliationBackendJob.mockResolvedValue({
      success: true,
      job: 'referral-reward-reconciliation',
      route: '/api/cron/referral-rewards',
      status: 'succeeded',
      summary: { processed: 1, settled: 1, failed: 0, failures: [] },
    });
    mocks.runWorkflowRunStepsBackendJob.mockReset();
    mocks.runWorkflowRunStepsBackendJob.mockResolvedValue({
      success: true,
      job: 'workflow-run-steps',
      route: '/api/cron/workflow-run-steps',
      status: 'skipped',
      skipped: true,
      reason: 'no_due_workflow_run_steps',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('rejects requests without the cron secret before touching Supabase', async () => {
    const { GET } = await import('@/app/api/cron/backend-jobs/route');
    const response = await GET(new Request('http://localhost/api/cron/backend-jobs', {
      headers: { 'x-request-id': 'cron-reject-1' },
    }));

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('cron-reject-1');
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.runAccountDeletionResweepsBackendJob).not.toHaveBeenCalled();
    expect(mocks.runBackendAlertDeliveryJob).not.toHaveBeenCalled();
    expect(mocks.runFeedMaintenanceBackendJob).not.toHaveBeenCalled();
    expect(mocks.runGenerationCompletionsBackendJob).not.toHaveBeenCalled();
    expect(mocks.runMediaPreviewRepairBackendJob).not.toHaveBeenCalled();
    expect(mocks.runMobilePushReceiptsBackendJob).not.toHaveBeenCalled();
    expect(mocks.runReferralRewardReconciliationBackendJob).not.toHaveBeenCalled();
  });

  it('runs every due logical backend job on the top-of-hour scheduler tick', async () => {
    const { GET } = await import('@/app/api/cron/backend-jobs/route');
    const response = await GET(new Request('http://localhost/api/cron/backend-jobs', {
      headers: {
        authorization: 'Bearer secret-123',
        'x-vercel-id': 'iad1::scheduler-1',
      },
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('iad1::scheduler-1');
    expect(mocks.createServiceClient).toHaveBeenCalledTimes(1);
    const expectedOptions = {
      startedAtMs: Date.parse('2026-06-22T10:00:00.000Z'),
      serviceClient: { service: 'supabase' },
      triggerRoute: '/api/cron/backend-jobs',
    };
    expect(mocks.runAccountDeletionResweepsBackendJob).toHaveBeenCalledWith({
      ...expectedOptions,
      requestId: 'iad1::scheduler-1:account-deletion-resweeps',
    });
    expect(mocks.runBackendAlertDeliveryJob).toHaveBeenCalledWith({
      ...expectedOptions,
      requestId: 'iad1::scheduler-1:backend-alert-delivery',
    });
    expect(mocks.runMobilePushReceiptsBackendJob).toHaveBeenCalledWith({
      ...expectedOptions,
      requestId: 'iad1::scheduler-1:mobile-push-receipts',
    });
    // F14: both are dedicated crons now. Vercel invokes their routes directly,
    // so the shared scheduler must leave them alone -- running them here too
    // would put the memory-heavy work straight back into this invocation.
    expect(mocks.runGenerationCompletionsBackendJob).not.toHaveBeenCalled();
    expect(mocks.runMediaPreviewRepairBackendJob).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      scheduler: '/api/cron/backend-jobs',
      dueJobs: ['account-deletion-resweeps', 'backend-alert-delivery', 'mobile-push-receipts', 'workflow-run-steps'],
    });
  });

  it('starts due logical jobs concurrently so one slow job does not block the scheduler tick', async () => {
    const alertResult = {
      success: true as const,
      job: 'backend-alert-delivery',
      route: '/api/cron/backend-alert-delivery',
      status: 'skipped' as const,
      skipped: true as const,
      reason: 'alert_delivery_not_configured',
    };
    const receiptsResult = {
      success: true as const,
      job: 'mobile-push-receipts',
      route: '/api/cron/mobile-push-receipts',
      status: 'succeeded' as const,
      summary: { updatedCount: 1 },
    };
    const workflowResult = {
      success: true as const,
      job: 'workflow-run-steps',
      route: '/api/cron/workflow-run-steps',
      status: 'succeeded' as const,
      summary: { claimed: 1 },
    };
    const alerts = deferredResult<typeof alertResult>();
    const receipts = deferredResult<typeof receiptsResult>();
    const workflow = deferredResult<typeof workflowResult>();
    mocks.runBackendAlertDeliveryJob.mockReturnValueOnce(alerts.promise);
    mocks.runMobilePushReceiptsBackendJob.mockReturnValueOnce(receipts.promise);
    mocks.runWorkflowRunStepsBackendJob.mockReturnValueOnce(workflow.promise);

    const { GET } = await import('@/app/api/cron/backend-jobs/route');
    const responsePromise = GET(new Request('http://localhost/api/cron/backend-jobs', {
      headers: {
        authorization: 'Bearer secret-123',
        'x-vercel-id': 'iad1::scheduler-concurrent',
      },
    }));

    await Promise.resolve();

    expect(mocks.runBackendAlertDeliveryJob).toHaveBeenCalledTimes(1);
    expect(mocks.runAccountDeletionResweepsBackendJob).toHaveBeenCalledTimes(1);
    expect(mocks.runMobilePushReceiptsBackendJob).toHaveBeenCalledTimes(1);
    expect(mocks.runWorkflowRunStepsBackendJob).toHaveBeenCalledTimes(1);

    alerts.resolve(alertResult);
    receipts.resolve(receiptsResult);
    workflow.resolve(workflowResult);

    const response = await responsePromise;

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      results: [
        expect.objectContaining({ job: 'account-deletion-resweeps', status: 'skipped' }),
        expect.objectContaining({ job: 'backend-alert-delivery', status: 'skipped' }),
        expect.objectContaining({ job: 'mobile-push-receipts', status: 'succeeded' }),
        expect.objectContaining({ job: 'workflow-run-steps', status: 'succeeded' }),
      ],
    });
  });

  it('skips hourly jobs on ordinary ten-minute scheduler ticks', async () => {
    vi.setSystemTime(new Date('2026-06-22T10:10:00.000Z'));

    const { GET } = await import('@/app/api/cron/backend-jobs/route');
    const response = await GET(new Request('http://localhost/api/cron/backend-jobs', {
      headers: { authorization: 'Bearer secret-123' },
    }));

    expect(response.status).toBe(200);
    expect(mocks.runAccountDeletionResweepsBackendJob).toHaveBeenCalledTimes(1);
    expect(mocks.runBackendAlertDeliveryJob).toHaveBeenCalledTimes(1);
    expect(mocks.runFeedMaintenanceBackendJob).not.toHaveBeenCalled();
    expect(mocks.runGenerationCompletionsBackendJob).not.toHaveBeenCalled();
    expect(mocks.runMediaPreviewRepairBackendJob).not.toHaveBeenCalled();
    expect(mocks.runMobilePushReceiptsBackendJob).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toMatchObject({
      dueJobs: ['account-deletion-resweeps', 'backend-alert-delivery', 'mobile-push-receipts', 'workflow-run-steps'],
    });
  });

  it('runs feed maintenance on the staggered hourly scheduler tick', async () => {
    vi.setSystemTime(new Date('2026-06-22T10:20:00.000Z'));

    const { GET } = await import('@/app/api/cron/backend-jobs/route');
    const response = await GET(new Request('http://localhost/api/cron/backend-jobs', {
      headers: {
        authorization: 'Bearer secret-123',
        'x-request-id': 'scheduler-feed-20',
      },
    }));

    expect(response.status).toBe(200);
    expect(mocks.runAccountDeletionResweepsBackendJob).toHaveBeenCalledTimes(1);
    expect(mocks.runFeedMaintenanceBackendJob).toHaveBeenCalledWith({
      requestId: 'scheduler-feed-20:feed-maintenance',
      startedAtMs: Date.parse('2026-06-22T10:20:00.000Z'),
      serviceClient: { service: 'supabase' },
      triggerRoute: '/api/cron/backend-jobs',
    });
    expect(mocks.runMediaPreviewRepairBackendJob).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      dueJobs: ['account-deletion-resweeps', 'backend-alert-delivery', 'feed-maintenance', 'mobile-push-receipts', 'workflow-run-steps'],
    });
  });

  it('runs referral reconciliation on its staggered hourly scheduler tick', async () => {
    vi.setSystemTime(new Date('2026-06-22T10:40:00.000Z'));

    const { GET } = await import('@/app/api/cron/backend-jobs/route');
    const response = await GET(new Request('http://localhost/api/cron/backend-jobs', {
      headers: {
        authorization: 'Bearer secret-123',
        'x-request-id': 'scheduler-referral-40',
      },
    }));

    expect(response.status).toBe(200);
    expect(mocks.runAccountDeletionResweepsBackendJob).toHaveBeenCalledTimes(1);
    expect(mocks.runReferralRewardReconciliationBackendJob).toHaveBeenCalledWith({
      requestId: 'scheduler-referral-40:referral-reward-reconciliation',
      startedAtMs: Date.parse('2026-06-22T10:40:00.000Z'),
      serviceClient: { service: 'supabase' },
      triggerRoute: '/api/cron/backend-jobs',
    });
    expect(mocks.runFeedMaintenanceBackendJob).not.toHaveBeenCalled();
    expect(mocks.runMediaPreviewRepairBackendJob).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      dueJobs: [
        'account-deletion-resweeps',
        'backend-alert-delivery',
        'mobile-push-receipts',
        'referral-reward-reconciliation',
        'workflow-run-steps',
      ],
    });
  });

  it('returns a failed scheduler invocation when any due job fails', async () => {
    mocks.runMobilePushReceiptsBackendJob.mockResolvedValueOnce({
      success: false,
      job: 'mobile-push-receipts',
      route: '/api/cron/mobile-push-receipts',
      status: 'failed',
      error: 'expo unavailable',
    });

    const { GET } = await import('@/app/api/cron/backend-jobs/route');
    const response = await GET(new Request('http://localhost/api/cron/backend-jobs', {
      headers: { authorization: 'Bearer secret-123' },
    }));

    expect(response.status).toBe(500);
    expect(mocks.runAccountDeletionResweepsBackendJob).toHaveBeenCalledTimes(1);
    expect(mocks.runBackendAlertDeliveryJob).toHaveBeenCalledTimes(1);
    expect(mocks.runMobilePushReceiptsBackendJob).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      results: [
        expect.objectContaining({ job: 'account-deletion-resweeps', status: 'skipped' }),
        expect.objectContaining({ status: 'skipped' }),
        expect.objectContaining({ job: 'mobile-push-receipts', status: 'failed' }),
        expect.objectContaining({ job: 'workflow-run-steps', status: 'skipped' }),
      ],
    });
  });
});
