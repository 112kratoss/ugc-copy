import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

type LockMockResult =
  | { acquired: true; value: unknown }
  | { acquired: false; reason: 'already_running' };

const mocks = vi.hoisted(() => ({
  createServiceClient: vi.fn(),
  processPendingMobilePushReceipts: vi.fn(),
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
    processPendingMobilePushReceipts: (...args: unknown[]) => mocks.processPendingMobilePushReceipts(...args),
  };
});

vi.mock('@/lib/backend-job-lock', () => ({
  withBackendJobLock: (client: unknown, options: unknown, task: () => Promise<unknown>) => (
    mocks.withBackendJobLock(client, options, task)
  ),
}));

describe('/api/cron/mobile-push-receipts route', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.createServiceClient.mockReset();
    mocks.processPendingMobilePushReceipts.mockReset();
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
    const response = await GET(new NextRequest('http://localhost/api/cron/mobile-push-receipts'));

    expect(response.status).toBe(401);
    expect(mocks.processPendingMobilePushReceipts).not.toHaveBeenCalled();
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
    expect(mocks.withBackendJobLock).not.toHaveBeenCalled();
    expect(mocks.processPendingMobilePushReceipts).not.toHaveBeenCalled();
  });

  it('runs the receipt processor for authorized requests', async () => {
    const { GET } = await import('@/app/api/cron/mobile-push-receipts/route');
    const response = await GET(new NextRequest('http://localhost/api/cron/mobile-push-receipts', {
      headers: {
        authorization: 'Bearer secret-123',
      },
    }));

    expect(response.status).toBe(200);
    expect(mocks.createServiceClient).toHaveBeenCalledTimes(1);
    expect(mocks.processPendingMobilePushReceipts).toHaveBeenCalledWith({ service: 'supabase' });
    expect(mocks.withBackendJobLock).toHaveBeenCalledWith(
      { service: 'supabase' },
      expect.objectContaining({
        name: 'mobile-push-receipts',
        ttlSeconds: 840,
      }),
      expect.any(Function),
    );
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      summary: {
        checkedCount: 1,
        updatedCount: 1,
      },
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
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      skipped: true,
      reason: 'already_running',
    });
    expect(mocks.processPendingMobilePushReceipts).not.toHaveBeenCalled();
  });
});
