import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  createServiceClient: vi.fn(),
  processPendingMobilePushReceipts: vi.fn(),
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

describe('/api/cron/mobile-push-receipts route', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.createServiceClient.mockReset();
    mocks.processPendingMobilePushReceipts.mockReset();
    mocks.createServiceClient.mockReturnValue({ service: 'supabase' });
    mocks.processPendingMobilePushReceipts.mockResolvedValue({
      checkedCount: 1,
      updatedCount: 1,
      staleCount: 0,
      disabledTokenCount: 0,
    });
    process.env.CRON_SECRET = 'secret-123';
  });

  it('rejects requests without the cron secret', async () => {
    const { GET } = await import('@/app/api/cron/mobile-push-receipts/route');
    const response = await GET(new NextRequest('http://localhost/api/cron/mobile-push-receipts'));

    expect(response.status).toBe(401);
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
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      summary: {
        checkedCount: 1,
        updatedCount: 1,
      },
    });
  });
});
