import { afterEach, describe, expect, it, vi } from 'vitest';

type LockMockResult =
  | { acquired: true; value: unknown }
  | { acquired: false; reason: 'already_running' };

const repairState = vi.hoisted(() => ({
  repair: vi.fn(async () => ({ attempted: 2, completed: 2, failed: 0 })),
}));

const lockState = vi.hoisted(() => ({
  withLock: vi.fn(async (_client, _options, task: () => Promise<unknown>): Promise<LockMockResult> => ({
    acquired: true,
    value: await task(),
  })),
}));

vi.mock('@/lib/media-preview-repair', () => ({
  repairMediaPreviews: repairState.repair,
}));

vi.mock('@/lib/backend-job-lock', () => ({
  withBackendJobLock: lockState.withLock,
}));

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => ({ service: true }),
}));

describe('media preview repair cron', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    repairState.repair.mockClear();
    lockState.withLock.mockClear();
    lockState.withLock.mockImplementation(async (_client, _options, task: () => Promise<unknown>): Promise<LockMockResult> => ({
      acquired: true,
      value: await task(),
    }));
  });

  it('requires the cron secret', async () => {
    vi.stubEnv('CRON_SECRET', 'secret');
    const { GET } = await import('@/app/api/cron/media-preview-repair/route');
    const response = await GET(new Request('http://localhost/api/cron/media-preview-repair'));
    expect(response.status).toBe(401);
    expect(repairState.repair).not.toHaveBeenCalled();
  });

  it('runs the shared repair service for authorized calls', async () => {
    vi.stubEnv('CRON_SECRET', 'secret');
    const { GET } = await import('@/app/api/cron/media-preview-repair/route');
    const response = await GET(new Request('http://localhost/api/cron/media-preview-repair', {
      headers: { authorization: 'Bearer secret' },
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      summary: { attempted: 2, completed: 2, failed: 0 },
    });
    expect(lockState.withLock).toHaveBeenCalledWith(
      { service: true },
      expect.objectContaining({
        name: 'media-preview-repair',
        ttlSeconds: 840,
      }),
      expect.any(Function),
    );
  });

  it('skips repair when another cron invocation already owns the lock', async () => {
    vi.stubEnv('CRON_SECRET', 'secret');
    lockState.withLock.mockResolvedValueOnce({ acquired: false, reason: 'already_running' });

    const { GET } = await import('@/app/api/cron/media-preview-repair/route');
    const response = await GET(new Request('http://localhost/api/cron/media-preview-repair', {
      headers: { authorization: 'Bearer secret' },
    }));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      skipped: true,
      reason: 'already_running',
    });
    expect(repairState.repair).not.toHaveBeenCalled();
  });
});
