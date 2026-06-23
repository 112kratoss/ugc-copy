import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BackendJobExecutionResult } from '@/lib/backend-job-executions';
import type { BackendJobDefinition } from '@/lib/backend-jobs';
import { runBackendJobsSchedulerForRoute } from '@/lib/backend-jobs-route-service';

function backendJob(name: BackendJobDefinition['name']): BackendJobDefinition {
  return {
    name,
    route: `/api/cron/${name}`,
    schedule: '*/10 * * * *',
    cadenceMinutes: 10,
    dailyInvocations: 144,
    maxDurationSeconds: 300,
    lockTtlSeconds: 840,
    noWorkSkipReason: 'no_work',
    maxMissedRunsBeforeDegraded: 3,
    healthExpectedMaxAgeMinutes: 30,
  };
}

function succeededResult(job: BackendJobDefinition['name']): BackendJobExecutionResult {
  return {
    success: true,
    job,
    route: `/api/cron/${job}`,
    status: 'succeeded',
    summary: { completed: 1 },
  };
}

describe('runBackendJobsSchedulerForRoute', () => {
  const serviceClient = { service: 'supabase' };
  const createServiceClient = vi.fn();
  const runGenerationCompletionsBackendJob = vi.fn();
  const runMediaPreviewRepairBackendJob = vi.fn();
  const runMobilePushReceiptsBackendJob = vi.fn();

  beforeEach(() => {
    createServiceClient.mockReset();
    createServiceClient.mockReturnValue(serviceClient);
    runGenerationCompletionsBackendJob.mockReset();
    runGenerationCompletionsBackendJob.mockResolvedValue(succeededResult('generation-completions'));
    runMediaPreviewRepairBackendJob.mockReset();
    runMediaPreviewRepairBackendJob.mockResolvedValue(succeededResult('media-preview-repair'));
    runMobilePushReceiptsBackendJob.mockReset();
    runMobilePushReceiptsBackendJob.mockResolvedValue(succeededResult('mobile-push-receipts'));
  });

  it('runs due backend jobs with one shared Supabase service client and route request ids', async () => {
    const request = new Request('http://localhost/api/cron/backend-jobs', {
      headers: { 'x-vercel-id': 'bom1::scheduler-42' },
    });

    const result = await runBackendJobsSchedulerForRoute({
      request,
      dependencies: {
        now: () => Date.parse('2026-06-23T10:00:00.000Z'),
        createServiceClient,
        getDueBackendJobs: () => [
          backendJob('generation-completions'),
          backendJob('media-preview-repair'),
          backendJob('mobile-push-receipts'),
        ],
        runGenerationCompletionsBackendJob,
        runMediaPreviewRepairBackendJob,
        runMobilePushReceiptsBackendJob,
      },
    });

    expect(result).toMatchObject({
      status: 200,
      body: {
        success: true,
        scheduler: '/api/cron/backend-jobs',
        dueJobs: ['generation-completions', 'media-preview-repair', 'mobile-push-receipts'],
        results: [
          expect.objectContaining({ job: 'generation-completions', status: 'succeeded' }),
          expect.objectContaining({ job: 'media-preview-repair', status: 'succeeded' }),
          expect.objectContaining({ job: 'mobile-push-receipts', status: 'succeeded' }),
        ],
      },
    });
    expect(createServiceClient).toHaveBeenCalledTimes(1);
    expect(runGenerationCompletionsBackendJob).toHaveBeenCalledWith({
      requestId: 'bom1::scheduler-42:generation-completions',
      startedAtMs: Date.parse('2026-06-23T10:00:00.000Z'),
      serviceClient,
      triggerRoute: '/api/cron/backend-jobs',
    });
    expect(runMediaPreviewRepairBackendJob).toHaveBeenCalledWith({
      requestId: 'bom1::scheduler-42:media-preview-repair',
      startedAtMs: Date.parse('2026-06-23T10:00:00.000Z'),
      serviceClient,
      triggerRoute: '/api/cron/backend-jobs',
    });
    expect(runMobilePushReceiptsBackendJob).toHaveBeenCalledWith({
      requestId: 'bom1::scheduler-42:mobile-push-receipts',
      startedAtMs: Date.parse('2026-06-23T10:00:00.000Z'),
      serviceClient,
      triggerRoute: '/api/cron/backend-jobs',
    });
  });

  it('skips without creating a Supabase client when no logical job is due', async () => {
    const result = await runBackendJobsSchedulerForRoute({
      request: new Request('http://localhost/api/cron/backend-jobs'),
      dependencies: {
        now: () => Date.parse('2026-06-23T10:05:00.000Z'),
        createServiceClient,
        getDueBackendJobs: () => [],
        runGenerationCompletionsBackendJob,
        runMediaPreviewRepairBackendJob,
        runMobilePushReceiptsBackendJob,
      },
    });

    expect(result).toEqual({
      status: 202,
      body: {
        success: true,
        skipped: true,
        reason: 'no_due_backend_jobs',
        scheduler: '/api/cron/backend-jobs',
      },
    });
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(runGenerationCompletionsBackendJob).not.toHaveBeenCalled();
    expect(runMediaPreviewRepairBackendJob).not.toHaveBeenCalled();
    expect(runMobilePushReceiptsBackendJob).not.toHaveBeenCalled();
  });

  it('returns a failed scheduler result when any due job fails', async () => {
    runMediaPreviewRepairBackendJob.mockResolvedValueOnce({
      success: false,
      job: 'media-preview-repair',
      route: '/api/cron/media-preview-repair',
      status: 'failed',
      error: 'storage timeout',
    });

    const result = await runBackendJobsSchedulerForRoute({
      request: new Request('http://localhost/api/cron/backend-jobs', {
        headers: { 'x-request-id': 'cron-500' },
      }),
      dependencies: {
        now: () => Date.parse('2026-06-23T10:00:00.000Z'),
        createServiceClient,
        getDueBackendJobs: () => [
          backendJob('generation-completions'),
          backendJob('media-preview-repair'),
        ],
        runGenerationCompletionsBackendJob,
        runMediaPreviewRepairBackendJob,
        runMobilePushReceiptsBackendJob,
      },
    });

    expect(result.status).toBe(500);
    expect(result.body).toMatchObject({
      success: false,
      dueJobs: ['generation-completions', 'media-preview-repair'],
      results: [
        expect.objectContaining({ job: 'generation-completions', status: 'succeeded' }),
        expect.objectContaining({ job: 'media-preview-repair', status: 'failed' }),
      ],
    });
  });
});
