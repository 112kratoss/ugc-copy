import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  collectBackendOpsDashboard: vi.fn(),
  createServiceClient: vi.fn(),
}));

vi.mock('@/lib/backend-ops-dashboard', () => ({
  collectBackendOpsDashboard: (...args: unknown[]) => mocks.collectBackendOpsDashboard(...args),
}));

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: (...args: unknown[]) => mocks.createServiceClient(...args),
}));

describe('/api/ops/backend-dashboard route', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.collectBackendOpsDashboard.mockReset();
    mocks.createServiceClient.mockReset();
    mocks.createServiceClient.mockReturnValue({ service: 'supabase' });
    mocks.collectBackendOpsDashboard.mockResolvedValue({
      status: 'ok',
      checkedAt: '2026-06-23T10:00:00.000Z',
      buildId: 'test-build',
      sources: {
        health: '/api/ops/backend-health',
        costs: '/api/ops/backend-costs',
        alerts: '/api/ops/backend-alerts',
      },
      panels: [],
      alertDelivery: {
        severity: 'ok',
        dedupeKey: 'backend-alerts:ok',
      },
    });
    process.env.CRON_SECRET = 'secret-123';
    process.env.OPS_READ_SECRET = 'ops-secret-123';
  });

  it('rejects unauthorized dashboard requests before touching Supabase', async () => {
    const { GET } = await import('@/app/api/ops/backend-dashboard/route');
    const response = await GET(new NextRequest('http://localhost/api/ops/backend-dashboard', {
      headers: { 'x-request-id': 'dashboard-unauthorized-1' },
    }));

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('dashboard-unauthorized-1');
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.collectBackendOpsDashboard).not.toHaveBeenCalled();
  });

  it('returns a no-store dashboard for authorized ops checks', async () => {
    const { GET } = await import('@/app/api/ops/backend-dashboard/route');
    const response = await GET(new NextRequest('http://localhost/api/ops/backend-dashboard', {
      headers: { authorization: 'Bearer ops-secret-123', 'x-request-id': 'dashboard-ok-1' },
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('dashboard-ok-1');
    expect(mocks.createServiceClient).toHaveBeenCalledOnce();
    expect(mocks.collectBackendOpsDashboard).toHaveBeenCalledWith({ service: 'supabase' });
    expect(body).toMatchObject({ status: 'ok', buildId: 'test-build' });
  });

  it('returns 503 when the dashboard is degraded', async () => {
    mocks.collectBackendOpsDashboard.mockResolvedValueOnce({
      status: 'degraded',
      checkedAt: '2026-06-23T10:00:00.000Z',
      panels: [
        {
          id: 'health',
          status: 'degraded',
          issueCount: 1,
        },
      ],
    });

    const { GET } = await import('@/app/api/ops/backend-dashboard/route');
    const response = await GET(new NextRequest('http://localhost/api/ops/backend-dashboard', {
      headers: { authorization: 'Bearer secret-123' },
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: 'degraded',
      panels: [expect.objectContaining({ id: 'health', status: 'degraded' })],
    });
  });

  it('returns 500 when dashboard collection fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.collectBackendOpsDashboard.mockRejectedValueOnce(new Error('database unavailable'));

    const { GET } = await import('@/app/api/ops/backend-dashboard/route');
    const response = await GET(new NextRequest('http://localhost/api/ops/backend-dashboard', {
      headers: { authorization: 'Bearer secret-123', 'x-request-id': 'dashboard-failed-1' },
    }));

    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('dashboard-failed-1');
    await expect(response.json()).resolves.toMatchObject({
      status: 'degraded',
      error: 'Failed to collect backend dashboard.',
    });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('backend_dashboard_failed'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('dashboard-failed-1'));
  });
});
