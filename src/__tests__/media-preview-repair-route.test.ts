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

const jobRunState = vi.hoisted(() => ({
  finish: vi.fn(async () => undefined),
  prune: vi.fn(async () => 0),
  start: vi.fn(async (_client, options: {
    name: string;
    route: string;
    requestId: string;
    lockOwner: string;
    startedAtMs: number;
  }) => ({
    id: 'run-1',
    ...options,
  })),
}));

vi.mock('@/lib/media-preview-repair', () => ({
  repairMediaPreviews: repairState.repair,
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

describe('media preview repair cron', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    jobRunState.finish.mockClear();
    jobRunState.prune.mockClear();
    jobRunState.start.mockClear();
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
    expect(jobRunState.start).not.toHaveBeenCalled();
  });

  it('fails closed when the cron secret is missing', async () => {
    vi.stubEnv('CRON_SECRET', undefined);
    const { GET } = await import('@/app/api/cron/media-preview-repair/route');
    const response = await GET(new Request('http://localhost/api/cron/media-preview-repair', {
      headers: { authorization: 'Bearer undefined' },
    }));
    expect(response.status).toBe(401);
    expect(repairState.repair).not.toHaveBeenCalled();
    expect(jobRunState.start).not.toHaveBeenCalled();
    expect(lockState.withLock).not.toHaveBeenCalled();
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
    expect(jobRunState.start).toHaveBeenCalledWith(
      { service: true },
      expect.objectContaining({
        name: 'media-preview-repair',
        route: '/api/cron/media-preview-repair',
      }),
    );
    expect(lockState.withLock).toHaveBeenCalledWith(
      { service: true },
      expect.objectContaining({
        name: 'media-preview-repair',
        ttlSeconds: 840,
      }),
      expect.any(Function),
    );
    expect(jobRunState.finish).toHaveBeenCalledWith(
      { service: true },
      expect.objectContaining({ id: 'run-1' }),
      expect.objectContaining({
        status: 'succeeded',
        summary: { attempted: 2, completed: 2, failed: 0 },
      }),
    );
    expect(jobRunState.prune).toHaveBeenCalledWith(
      { service: true },
      expect.objectContaining({ nowMs: expect.any(Number) }),
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
    expect(jobRunState.finish).toHaveBeenCalledWith(
      { service: true },
      expect.objectContaining({ id: 'run-1' }),
      expect.objectContaining({
        status: 'skipped',
        skipReason: 'already_running',
      }),
    );
    expect(jobRunState.prune).toHaveBeenCalledWith(
      { service: true },
      expect.objectContaining({ nowMs: expect.any(Number) }),
    );
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      skipped: true,
      reason: 'already_running',
    });
    expect(repairState.repair).not.toHaveBeenCalled();
  });

  it('records failed repair attempts before returning a retryable error', async () => {
    vi.stubEnv('CRON_SECRET', 'secret');
    repairState.repair.mockRejectedValueOnce(new Error('repair failed'));

    const { GET } = await import('@/app/api/cron/media-preview-repair/route');
    const response = await GET(new Request('http://localhost/api/cron/media-preview-repair', {
      headers: { authorization: 'Bearer secret' },
    }));

    expect(response.status).toBe(500);
    expect(jobRunState.finish).toHaveBeenCalledWith(
      { service: true },
      expect.objectContaining({ id: 'run-1' }),
      expect.objectContaining({
        status: 'failed',
        errorMessage: 'repair failed',
      }),
    );
    expect(jobRunState.prune).toHaveBeenCalledWith(
      { service: true },
      expect.objectContaining({ nowMs: expect.any(Number) }),
    );
  });
});
