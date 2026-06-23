import fs from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

type LockMockResult =
  | { acquired: true; value: unknown }
  | { acquired: false; reason: 'already_running' };

const mocks = vi.hoisted(() => ({
  createServiceClient: vi.fn(),
  finishBackendJobRun: vi.fn(async (_client: unknown, _run: unknown, _options: unknown) => {
    void _client;
    void _run;
    void _options;
  }),
  pruneBackendJobRuns: vi.fn(async (_client: unknown, _options?: unknown) => {
    void _client;
    void _options;
    return 0;
  }),
  hasPendingMobilePushReceipts: vi.fn(async (_client: unknown) => {
    void _client;
    return true;
  }),
  processPendingMobilePushReceipts: vi.fn(),
  startBackendJobRun: vi.fn(async (_client, options: {
    name: string;
    route: string;
    requestId: string;
    lockOwner: string;
    startedAtMs: number;
  }) => ({
    id: 'run-1',
    ...options,
  })),
  withBackendJobLock: vi.fn(async (_client, _options, task: () => Promise<unknown>): Promise<LockMockResult> => ({
    acquired: true,
    value: await task(),
  })),
}));

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: (...args: unknown[]) => mocks.createServiceClient(...args),
}));

vi.mock('@/lib/mobile-notifications', async () => {
  const actual = await vi.importActual<typeof import('@/lib/mobile-notifications')>('@/lib/mobile-notifications');
  return {
    ...actual,
    hasPendingMobilePushReceipts: (...args: unknown[]) => mocks.hasPendingMobilePushReceipts(...args),
    processPendingMobilePushReceipts: (...args: unknown[]) => mocks.processPendingMobilePushReceipts(...args),
  };
});

vi.mock('@/lib/backend-job-lock', () => ({
  withBackendJobLock: (client: unknown, options: unknown, task: () => Promise<unknown>) => (
    mocks.withBackendJobLock(client, options, task)
  ),
}));

vi.mock('@/lib/backend-job-runs', () => ({
  finishBackendJobRun: (client: unknown, run: unknown, options: unknown) => (
    mocks.finishBackendJobRun(client, run, options)
  ),
  maybePruneBackendJobRuns: (client: unknown, options: unknown) => mocks.pruneBackendJobRuns(client, options),
  startBackendJobRun: (client: unknown, options: unknown) => mocks.startBackendJobRun(
    client,
    options as {
      name: string;
      route: string;
      requestId: string;
      lockOwner: string;
      startedAtMs: number;
    },
  ),
}));

describe('/api/cron/mobile-push-receipts route', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.createServiceClient.mockReset();
    mocks.finishBackendJobRun.mockClear();
    mocks.hasPendingMobilePushReceipts.mockReset();
    mocks.hasPendingMobilePushReceipts.mockResolvedValue(true);
    mocks.pruneBackendJobRuns.mockClear();
    mocks.processPendingMobilePushReceipts.mockReset();
    mocks.startBackendJobRun.mockClear();
    mocks.withBackendJobLock.mockReset();
    mocks.createServiceClient.mockReturnValue({ service: 'supabase' });
    mocks.processPendingMobilePushReceipts.mockResolvedValue({
      checkedCount: 1,
      updatedCount: 1,
      staleCount: 0,
      disabledTokenCount: 0,
    });
    mocks.withBackendJobLock.mockImplementation(async (_client, _options, task: () => Promise<unknown>): Promise<LockMockResult> => ({
      acquired: true,
      value: await task(),
    }));
    process.env.CRON_SECRET = 'secret-123';
  });

  it('rejects requests without the cron secret', async () => {
    const { GET } = await import('@/app/api/cron/mobile-push-receipts/route');
    const response = await GET(new NextRequest('http://localhost/api/cron/mobile-push-receipts', {
      headers: { 'x-request-id': 'push-receipts-reject-1' },
    }));

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('push-receipts-reject-1');
    expect(mocks.processPendingMobilePushReceipts).not.toHaveBeenCalled();
    expect(mocks.startBackendJobRun).not.toHaveBeenCalled();
  });

  it('fails closed when the cron secret is missing', async () => {
    delete process.env.CRON_SECRET;

    const { GET } = await import('@/app/api/cron/mobile-push-receipts/route');
    const response = await GET(new NextRequest('http://localhost/api/cron/mobile-push-receipts', {
      headers: {
        authorization: 'Bearer undefined',
      },
    }));

    expect(response.status).toBe(401);
    expect(mocks.startBackendJobRun).not.toHaveBeenCalled();
    expect(mocks.withBackendJobLock).not.toHaveBeenCalled();
    expect(mocks.processPendingMobilePushReceipts).not.toHaveBeenCalled();
  });

  it('runs the receipt processor for authorized requests', async () => {
    const { GET } = await import('@/app/api/cron/mobile-push-receipts/route');
    const response = await GET(new NextRequest('http://localhost/api/cron/mobile-push-receipts', {
      headers: {
        authorization: 'Bearer secret-123',
        'x-request-id': 'push-receipts-run-1',
      },
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('push-receipts-run-1');
    expect(mocks.createServiceClient).toHaveBeenCalledTimes(1);
    expect(mocks.startBackendJobRun).toHaveBeenCalledWith(
      { service: 'supabase' },
      expect.objectContaining({
        name: 'mobile-push-receipts',
        route: '/api/cron/mobile-push-receipts',
        requestId: 'push-receipts-run-1',
      }),
    );
    expect(mocks.hasPendingMobilePushReceipts).toHaveBeenCalledWith(
      { service: 'supabase' },
      { now: expect.any(Date) },
    );
    expect(mocks.processPendingMobilePushReceipts).toHaveBeenCalledWith(
      { service: 'supabase' },
      { now: expect.any(Date) },
    );
    expect(mocks.withBackendJobLock).toHaveBeenCalledWith(
      { service: 'supabase' },
      expect.objectContaining({
        name: 'mobile-push-receipts',
        ttlSeconds: 840,
      }),
      expect.any(Function),
    );
    expect(mocks.finishBackendJobRun).toHaveBeenCalledWith(
      { service: 'supabase' },
      expect.objectContaining({ id: 'run-1' }),
      expect.objectContaining({
        status: 'succeeded',
        summary: {
          checkedCount: 1,
          updatedCount: 1,
          staleCount: 0,
          disabledTokenCount: 0,
        },
      }),
    );
    expect(mocks.pruneBackendJobRuns).toHaveBeenCalledWith(
      { service: 'supabase' },
      expect.objectContaining({ nowMs: expect.any(Number) }),
    );
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      summary: {
        checkedCount: 1,
        updatedCount: 1,
      },
    });
  });

  it('records a skipped job-run without taking the lock when no push receipts are pending', async () => {
    mocks.hasPendingMobilePushReceipts.mockResolvedValueOnce(false);

    const { GET } = await import('@/app/api/cron/mobile-push-receipts/route');
    const response = await GET(new NextRequest('http://localhost/api/cron/mobile-push-receipts', {
      headers: {
        authorization: 'Bearer secret-123',
      },
    }));

    expect(response.status).toBe(202);
    expect(mocks.hasPendingMobilePushReceipts).toHaveBeenCalledWith(
      { service: 'supabase' },
      { now: expect.any(Date) },
    );
    expect(mocks.startBackendJobRun).toHaveBeenCalledWith(
      { service: 'supabase' },
      expect.objectContaining({
        name: 'mobile-push-receipts',
        route: '/api/cron/mobile-push-receipts',
      }),
    );
    expect(mocks.withBackendJobLock).not.toHaveBeenCalled();
    expect(mocks.processPendingMobilePushReceipts).not.toHaveBeenCalled();
    expect(mocks.finishBackendJobRun).toHaveBeenCalledWith(
      { service: 'supabase' },
      expect.objectContaining({ id: 'run-1' }),
      expect.objectContaining({
        status: 'skipped',
        skipReason: 'no_pending_receipts',
      }),
    );
    expect(mocks.pruneBackendJobRuns).toHaveBeenCalledWith(
      { service: 'supabase' },
      expect.objectContaining({ nowMs: expect.any(Number) }),
    );
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      skipped: true,
      reason: 'no_pending_receipts',
    });
  });

  it('skips processing when another receipt cron invocation already owns the lock', async () => {
    mocks.withBackendJobLock.mockResolvedValueOnce({ acquired: false, reason: 'already_running' });

    const { GET } = await import('@/app/api/cron/mobile-push-receipts/route');
    const response = await GET(new NextRequest('http://localhost/api/cron/mobile-push-receipts', {
      headers: {
        authorization: 'Bearer secret-123',
      },
    }));

    expect(response.status).toBe(202);
    expect(mocks.finishBackendJobRun).toHaveBeenCalledWith(
      { service: 'supabase' },
      expect.objectContaining({ id: 'run-1' }),
      expect.objectContaining({
        status: 'skipped',
        skipReason: 'already_running',
      }),
    );
    expect(mocks.pruneBackendJobRuns).toHaveBeenCalledWith(
      { service: 'supabase' },
      expect.objectContaining({ nowMs: expect.any(Number) }),
    );
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      skipped: true,
      reason: 'already_running',
    });
    expect(mocks.processPendingMobilePushReceipts).not.toHaveBeenCalled();
  });

  it('records failed receipt processing before returning a retryable error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.processPendingMobilePushReceipts.mockRejectedValueOnce(new Error('receipt processor failed'));

    const { GET } = await import('@/app/api/cron/mobile-push-receipts/route');
    const response = await GET(new NextRequest('http://localhost/api/cron/mobile-push-receipts', {
      headers: {
        authorization: 'Bearer secret-123',
      },
    }));

    expect(response.status).toBe(500);
    expect(mocks.finishBackendJobRun).toHaveBeenCalledWith(
      { service: 'supabase' },
      expect.objectContaining({ id: 'run-1' }),
      expect.objectContaining({
        status: 'failed',
        errorMessage: 'receipt processor failed',
      }),
    );
    expect(mocks.pruneBackendJobRuns).toHaveBeenCalledWith(
      { service: 'supabase' },
      expect.objectContaining({ nowMs: expect.any(Number) }),
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('mobile_push_receipts_failed'));
  });

  it('is covered by the shared Vercel Pro backend job orchestrator', () => {
    const vercel = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'vercel.json'), 'utf8'));

    expect(vercel.crons).toContainEqual({
      path: '/api/cron/backend-jobs',
      schedule: '*/10 * * * *',
    });
    expect(vercel.crons).not.toContainEqual(expect.objectContaining({
      path: '/api/cron/mobile-push-receipts',
    }));
  });
});
