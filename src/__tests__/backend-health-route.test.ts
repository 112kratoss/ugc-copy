import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  collectBackendHealth: vi.fn(),
  createServiceClient: vi.fn(),
}));

vi.mock('@/lib/backend-health', () => ({
  collectBackendHealth: (...args: unknown[]) => mocks.collectBackendHealth(...args),
}));

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: (...args: unknown[]) => mocks.createServiceClient(...args),
}));

describe('/api/ops/backend-health route', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.collectBackendHealth.mockReset();
    mocks.createServiceClient.mockReset();
    mocks.createServiceClient.mockReturnValue({ service: 'supabase' });
    mocks.collectBackendHealth.mockResolvedValue({
      status: 'ok',
      checkedAt: '2026-06-21T10:00:00.000Z',
      buildId: 'test-build',
      catalog: { revision: 'catalog-revision', schemaVersion: 1, activeModels: 12 },
      scheduler: {
        status: 'ok',
        route: '/api/cron/backend-jobs',
        schedule: '*/10 * * * *',
        dailyInvocations: 144,
        dailyInvocationBudget: 180,
      },
      jobs: [],
      generations: {
        status: 'ok',
        recentWindowMinutes: 60,
        stalledAfterMinutes: 60,
        recentCounts: {},
        stalledActiveCount: 0,
        oldestStalledCreatedAt: null,
      },
      issues: [],
    });
    process.env.CRON_SECRET = 'secret-123';
  });

  it('rejects unauthorized health checks', async () => {
    const { GET } = await import('@/app/api/ops/backend-health/route');
    const response = await GET(new NextRequest('http://localhost/api/ops/backend-health', {
      headers: { 'x-request-id': 'health-unauthorized-1' },
    }));

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('health-unauthorized-1');
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.collectBackendHealth).not.toHaveBeenCalled();
  });

  it('returns no-store health for authorized checks', async () => {
    const { GET } = await import('@/app/api/ops/backend-health/route');
    const response = await GET(new NextRequest('http://localhost/api/ops/backend-health', {
      headers: { authorization: 'Bearer secret-123', 'x-request-id': 'health-ok-1' },
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('health-ok-1');
    expect(mocks.createServiceClient).toHaveBeenCalledOnce();
    expect(mocks.collectBackendHealth).toHaveBeenCalledWith(
      { service: 'supabase' },
      undefined,
      process.env,
    );
    expect(body).toMatchObject({ status: 'ok', buildId: 'test-build' });
  });

  it('returns 503 when the collected health is degraded', async () => {
    mocks.collectBackendHealth.mockResolvedValueOnce({
      status: 'degraded',
      checkedAt: '2026-06-21T10:00:00.000Z',
      buildId: 'test-build',
      catalog: { revision: 'catalog-revision', schemaVersion: 1, activeModels: 12 },
      scheduler: {
        status: 'ok',
        route: '/api/cron/backend-jobs',
        schedule: '*/10 * * * *',
        dailyInvocations: 144,
        dailyInvocationBudget: 180,
      },
      jobs: [],
      generations: {
        status: 'degraded',
        recentWindowMinutes: 60,
        stalledAfterMinutes: 60,
        recentCounts: {},
        stalledActiveCount: 1,
        oldestStalledCreatedAt: '2026-06-21T08:30:00.000Z',
      },
      issues: [{ severity: 'degraded', code: 'GENERATION_STALLED_ACTIVE', message: 'stalled' }],
    });

    const { GET } = await import('@/app/api/ops/backend-health/route');
    const response = await GET(new NextRequest('http://localhost/api/ops/backend-health', {
      headers: { authorization: 'Bearer secret-123' },
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: 'degraded',
      issues: [expect.objectContaining({ code: 'GENERATION_STALLED_ACTIVE' })],
    });
  });

  it('returns 500 when health collection fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.collectBackendHealth.mockRejectedValueOnce(new Error('database unavailable'));

    const { GET } = await import('@/app/api/ops/backend-health/route');
    const response = await GET(new NextRequest('http://localhost/api/ops/backend-health', {
      headers: { authorization: 'Bearer secret-123', 'x-request-id': 'health-failed-1' },
    }));

    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('health-failed-1');
    await expect(response.json()).resolves.toMatchObject({
      status: 'degraded',
      error: 'Failed to collect backend health.',
    });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('backend_health_failed'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('health-failed-1'));
  });
});
