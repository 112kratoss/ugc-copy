import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createServiceClient: vi.fn(),
  runBackendAlertDeliveryJob: vi.fn(),
  runGenerationCompletionsBackendJob: vi.fn(),
  runMediaPreviewRepairBackendJob: vi.fn(),
  runMobilePushReceiptsBackendJob: vi.fn(),
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
    runBackendAlertDeliveryJob: (...args: unknown[]) => (
      mocks.runBackendAlertDeliveryJob(...args)
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
    expect(mocks.runBackendAlertDeliveryJob).not.toHaveBeenCalled();
    expect(mocks.runGenerationCompletionsBackendJob).not.toHaveBeenCalled();
    expect(mocks.runMediaPreviewRepairBackendJob).not.toHaveBeenCalled();
    expect(mocks.runMobilePushReceiptsBackendJob).not.toHaveBeenCalled();
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
    expect(mocks.runBackendAlertDeliveryJob).toHaveBeenCalledWith({
      ...expectedOptions,
      requestId: 'iad1::scheduler-1:backend-alert-delivery',
    });
    expect(mocks.runGenerationCompletionsBackendJob).toHaveBeenCalledWith({
      ...expectedOptions,
      requestId: 'iad1::scheduler-1:generation-completions',
    });
    expect(mocks.runMediaPreviewRepairBackendJob).toHaveBeenCalledWith({
      ...expectedOptions,
      requestId: 'iad1::scheduler-1:media-preview-repair',
    });
    expect(mocks.runMobilePushReceiptsBackendJob).toHaveBeenCalledWith({
      ...expectedOptions,
      requestId: 'iad1::scheduler-1:mobile-push-receipts',
    });
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      scheduler: '/api/cron/backend-jobs',
      dueJobs: ['backend-alert-delivery', 'generation-completions', 'media-preview-repair', 'mobile-push-receipts'],
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
    const generationResult = {
      success: true as const,
      job: 'generation-completions',
      route: '/api/cron/generation-completions',
      status: 'succeeded' as const,
      summary: { completed: 1 },
    };
    const repairResult = {
      success: true as const,
      job: 'media-preview-repair',
      route: '/api/cron/media-preview-repair',
      status: 'skipped' as const,
      skipped: true as const,
      reason: 'no_repairable_media',
    };
    const receiptsResult = {
      success: true as const,
      job: 'mobile-push-receipts',
      route: '/api/cron/mobile-push-receipts',
      status: 'succeeded' as const,
      summary: { updatedCount: 1 },
    };
    const alerts = deferredResult<typeof alertResult>();
    const generation = deferredResult<typeof generationResult>();
    const repair = deferredResult<typeof repairResult>();
    const receipts = deferredResult<typeof receiptsResult>();
    mocks.runBackendAlertDeliveryJob.mockReturnValueOnce(alerts.promise);
    mocks.runGenerationCompletionsBackendJob.mockReturnValueOnce(generation.promise);
    mocks.runMediaPreviewRepairBackendJob.mockReturnValueOnce(repair.promise);
    mocks.runMobilePushReceiptsBackendJob.mockReturnValueOnce(receipts.promise);

    const { GET } = await import('@/app/api/cron/backend-jobs/route');
    const responsePromise = GET(new Request('http://localhost/api/cron/backend-jobs', {
      headers: {
        authorization: 'Bearer secret-123',
        'x-vercel-id': 'iad1::scheduler-concurrent',
      },
    }));

    await Promise.resolve();

    expect(mocks.runBackendAlertDeliveryJob).toHaveBeenCalledTimes(1);
    expect(mocks.runGenerationCompletionsBackendJob).toHaveBeenCalledTimes(1);
    expect(mocks.runMediaPreviewRepairBackendJob).toHaveBeenCalledTimes(1);
    expect(mocks.runMobilePushReceiptsBackendJob).toHaveBeenCalledTimes(1);

    alerts.resolve(alertResult);
    generation.resolve(generationResult);
    repair.resolve(repairResult);
    receipts.resolve(receiptsResult);

    const response = await responsePromise;

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      results: [
        expect.objectContaining({ job: 'backend-alert-delivery', status: 'skipped' }),
        expect.objectContaining({ job: 'generation-completions', status: 'succeeded' }),
        expect.objectContaining({ job: 'media-preview-repair', status: 'skipped' }),
        expect.objectContaining({ job: 'mobile-push-receipts', status: 'succeeded' }),
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
    expect(mocks.runBackendAlertDeliveryJob).toHaveBeenCalledTimes(1);
    expect(mocks.runGenerationCompletionsBackendJob).toHaveBeenCalledTimes(1);
    expect(mocks.runMediaPreviewRepairBackendJob).not.toHaveBeenCalled();
    expect(mocks.runMobilePushReceiptsBackendJob).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toMatchObject({
      dueJobs: ['backend-alert-delivery', 'generation-completions', 'mobile-push-receipts'],
    });
  });

  it('returns a failed scheduler invocation when any due job fails', async () => {
    mocks.runGenerationCompletionsBackendJob.mockResolvedValueOnce({
      success: false,
      job: 'generation-completions',
      route: '/api/cron/generation-completions',
      status: 'failed',
      error: 'provider timeout',
    });

    const { GET } = await import('@/app/api/cron/backend-jobs/route');
    const response = await GET(new Request('http://localhost/api/cron/backend-jobs', {
      headers: { authorization: 'Bearer secret-123' },
    }));

    expect(response.status).toBe(500);
    expect(mocks.runBackendAlertDeliveryJob).toHaveBeenCalledTimes(1);
    expect(mocks.runGenerationCompletionsBackendJob).toHaveBeenCalledTimes(1);
    expect(mocks.runMediaPreviewRepairBackendJob).toHaveBeenCalledTimes(1);
    expect(mocks.runMobilePushReceiptsBackendJob).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      results: [
        expect.objectContaining({ status: 'skipped' }),
        expect.objectContaining({ status: 'failed' }),
        expect.objectContaining({ status: 'succeeded' }),
        expect.objectContaining({ status: 'succeeded' }),
      ],
    });
  });
});
