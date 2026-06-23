import { describe, expect, it, vi } from 'vitest';

import { createBackendJobsRouteHandlers } from '@/lib/backend-jobs-route-adapter-service';

describe('backend jobs scheduler route adapter service', () => {
  it('rejects unauthorized scheduler requests before running backend jobs', async () => {
    const runBackendJobsSchedulerForRoute = vi.fn();
    const { GET } = createBackendJobsRouteHandlers({
      dependencies: {
        isAuthorizedCronRequest: () => false,
        runBackendJobsSchedulerForRoute,
      },
    });
    const request = new Request('http://localhost/api/cron/backend-jobs', {
      headers: { 'x-request-id': 'scheduler-reject-1' },
    });

    const response = await GET(request);

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('scheduler-reject-1');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(runBackendJobsSchedulerForRoute).not.toHaveBeenCalled();
  });

  it('returns the scheduler result with private API headers for authorized cron requests', async () => {
    const runBackendJobsSchedulerForRoute = vi.fn(async () => ({
      status: 202 as const,
      body: {
        success: true as const,
        skipped: true as const,
        reason: 'no_due_backend_jobs' as const,
        scheduler: '/api/cron/backend-jobs' as const,
      },
    }));
    const { GET } = createBackendJobsRouteHandlers({
      dependencies: {
        isAuthorizedCronRequest: () => true,
        runBackendJobsSchedulerForRoute,
      },
    });
    const request = new Request('http://localhost/api/cron/backend-jobs', {
      headers: { 'x-vercel-id': 'bom1::scheduler-2' },
    });

    const response = await GET(request);

    expect(response.status).toBe(202);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('bom1::scheduler-2');
    expect(runBackendJobsSchedulerForRoute).toHaveBeenCalledWith({ request });
    await expect(response.json()).resolves.toEqual({
      success: true,
      skipped: true,
      reason: 'no_due_backend_jobs',
      scheduler: '/api/cron/backend-jobs',
    });
  });
});
