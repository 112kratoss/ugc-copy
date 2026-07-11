import { afterEach, describe, expect, it, vi } from 'vitest';

type LockMockResult =
  | { acquired: true; value: unknown }
  | { acquired: false; reason: 'already_running' };

const maintenanceState = vi.hoisted(() => ({
  maintain: vi.fn(async () => ({
    asOf: '2026-07-11T07:20:00.000Z',
    postStatsRefreshed: 18,
    userInterestProfilesRefreshed: 7,
    retention: { skipped: false, events_deleted: 3 },
  })),
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
  }) => ({ id: 'run-feed-1', ...options })),
}));

vi.mock('@/lib/feed-maintenance', () => ({
  maintainFeedPersonalization: maintenanceState.maintain,
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

describe('feed maintenance cron', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    jobRunState.finish.mockClear();
    jobRunState.prune.mockClear();
    jobRunState.start.mockClear();
    maintenanceState.maintain.mockClear();
    lockState.withLock.mockClear();
    lockState.withLock.mockImplementation(async (_client, _options, task: () => Promise<unknown>): Promise<LockMockResult> => ({
      acquired: true,
      value: await task(),
    }));
  });

  it('rejects unauthorized requests before creating a job run', async () => {
    vi.stubEnv('CRON_SECRET', 'secret');
    const { GET } = await import('@/app/api/cron/feed-maintenance/route');

    const response = await GET(new Request('http://localhost/api/cron/feed-maintenance', {
      headers: { 'x-request-id': 'feed-maintenance-reject-1' },
    }));

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('feed-maintenance-reject-1');
    expect(jobRunState.start).not.toHaveBeenCalled();
    expect(maintenanceState.maintain).not.toHaveBeenCalled();
  });

  it('runs bounded feed maintenance behind the shared job lock', async () => {
    vi.stubEnv('CRON_SECRET', 'secret');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-11T07:20:00.000Z'));
    const { GET } = await import('@/app/api/cron/feed-maintenance/route');

    const response = await GET(new Request('http://localhost/api/cron/feed-maintenance', {
      headers: {
        authorization: 'Bearer secret',
        'x-request-id': 'feed-maintenance-run-1',
      },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      summary: {
        postStatsRefreshed: 18,
        userInterestProfilesRefreshed: 7,
        retention: { events_deleted: 3 },
      },
    });
    expect(jobRunState.start).toHaveBeenCalledWith(
      { service: true },
      expect.objectContaining({
        name: 'feed-maintenance',
        route: '/api/cron/feed-maintenance',
        requestId: 'feed-maintenance-run-1',
      }),
    );
    expect(lockState.withLock).toHaveBeenCalledWith(
      { service: true },
      expect.objectContaining({ name: 'feed-maintenance', ttlSeconds: 840 }),
      expect.any(Function),
    );
    expect(maintenanceState.maintain).toHaveBeenCalledWith(
      { service: true },
      { now: new Date('2026-07-11T07:20:00.000Z') },
    );
    expect(jobRunState.finish).toHaveBeenCalledWith(
      { service: true },
      expect.objectContaining({ id: 'run-feed-1' }),
      expect.objectContaining({ status: 'succeeded' }),
    );
  });

  it('returns a retryable failure and records the failed run', async () => {
    vi.stubEnv('CRON_SECRET', 'secret');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    maintenanceState.maintain.mockRejectedValueOnce(new Error('feed stats timeout'));
    const { GET } = await import('@/app/api/cron/feed-maintenance/route');

    const response = await GET(new Request('http://localhost/api/cron/feed-maintenance', {
      headers: { authorization: 'Bearer secret' },
    }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'Failed to maintain feed personalization data.',
    });
    expect(jobRunState.finish).toHaveBeenCalledWith(
      { service: true },
      expect.objectContaining({ id: 'run-feed-1' }),
      expect.objectContaining({ status: 'failed', errorMessage: 'feed stats timeout' }),
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('feed_maintenance_failed'));
  });
});
