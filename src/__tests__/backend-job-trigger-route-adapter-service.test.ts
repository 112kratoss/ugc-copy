import { describe, expect, it, vi } from 'vitest';

import type { BackendJobExecutionResult } from '@/lib/backend-job-executions';
import {
  createBackendJobTriggerRouteHandlers,
  getBackendJobTriggerRouteResponse,
} from '@/lib/backend-job-trigger-route-adapter-service';

describe('backend job trigger route adapter service', () => {
  it('rejects unauthorized cron requests before running the backend job', async () => {
    const runJob = vi.fn();
    const request = new Request('http://localhost/api/cron/generation-completions', {
      headers: { 'x-request-id': 'cron-trigger-reject-1' },
    });

    const response = await getBackendJobTriggerRouteResponse({
      failureMessage: 'Failed to process generation completions.',
      request,
      runJob,
      dependencies: {
        isAuthorizedCronRequest: () => false,
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('cron-trigger-reject-1');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(runJob).not.toHaveBeenCalled();
  });

  it('runs authorized cron jobs with the request id and shared response mapper', async () => {
    const result: BackendJobExecutionResult = {
      success: true,
      job: 'mobile-push-receipts',
      route: '/api/cron/mobile-push-receipts',
      status: 'succeeded',
      summary: { checkedCount: 2 },
    };
    const runJob = vi.fn(async () => result);
    const request = new Request('http://localhost/api/cron/mobile-push-receipts', {
      headers: {
        authorization: 'Bearer secret',
        'x-request-id': 'cron-trigger-run-1',
      },
    });

    const response = await getBackendJobTriggerRouteResponse({
      failureMessage: 'Failed to process mobile push receipts.',
      request,
      runJob,
      dependencies: {
        getBackendJobRequestId: () => 'cron-trigger-run-1',
        isAuthorizedCronRequest: () => true,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('cron-trigger-run-1');
    expect(runJob).toHaveBeenCalledWith({ requestId: 'cron-trigger-run-1' });
    await expect(response.json()).resolves.toEqual({
      success: true,
      summary: { checkedCount: 2 },
    });
  });

  it('creates trigger route handlers that forward GET requests through the adapter', async () => {
    const result: BackendJobExecutionResult = {
      success: true,
      job: 'media-preview-repair',
      route: '/api/cron/media-preview-repair',
      status: 'succeeded',
      summary: { repairedCount: 1 },
    };
    const runJob = vi.fn(async () => result);
    const { GET } = createBackendJobTriggerRouteHandlers({
      failureMessage: 'Failed to repair media previews.',
      runJob,
      dependencies: {
        getBackendJobRequestId: () => 'cron-trigger-factory-1',
        isAuthorizedCronRequest: () => true,
      },
    });

    const response = await GET(new Request('http://localhost/api/cron/media-preview-repair', {
      headers: { 'x-request-id': 'cron-trigger-factory-1' },
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('cron-trigger-factory-1');
    expect(runJob).toHaveBeenCalledWith({ requestId: 'cron-trigger-factory-1' });
    await expect(response.json()).resolves.toEqual({
      success: true,
      summary: { repairedCount: 1 },
    });
  });
});
