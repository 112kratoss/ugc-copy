import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  collectBackendAlerts: vi.fn(),
  createServiceClient: vi.fn(),
}));

vi.mock('@/lib/backend-alerts', () => ({
  collectBackendAlerts: (...args: unknown[]) => mocks.collectBackendAlerts(...args),
}));

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: (...args: unknown[]) => mocks.createServiceClient(...args),
}));

describe('/api/ops/backend-alerts route', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.collectBackendAlerts.mockReset();
    mocks.createServiceClient.mockReset();
    mocks.createServiceClient.mockReturnValue({ service: 'supabase' });
    mocks.collectBackendAlerts.mockResolvedValue({
      status: 'ok',
      checkedAt: '2026-06-22T10:00:00.000Z',
      buildId: 'test-build',
      signals: {
        healthStatus: 'ok',
        costStatus: 'ok',
        costWindowHours: 24,
      },
      counts: { total: 0, degraded: 0, warning: 0 },
      monitorEndpoints: [
        '/api/ops/backend-health',
        '/api/ops/backend-costs',
        '/api/ops/backend-alerts',
      ],
      alerts: [],
    });
    process.env.CRON_SECRET = 'secret-123';
  });

  it('rejects unauthorized alert requests before touching Supabase', async () => {
    const { GET } = await import('@/app/api/ops/backend-alerts/route');
    const response = await GET(new NextRequest('http://localhost/api/ops/backend-alerts', {
      headers: { 'x-request-id': 'alerts-unauthorized-1' },
    }));

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('alerts-unauthorized-1');
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.collectBackendAlerts).not.toHaveBeenCalled();
  });

  it('returns no-store alerts for authorized ops checks', async () => {
    const { GET } = await import('@/app/api/ops/backend-alerts/route');
    const response = await GET(new NextRequest('http://localhost/api/ops/backend-alerts', {
      headers: { authorization: 'Bearer secret-123', 'x-request-id': 'alerts-ok-1' },
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('alerts-ok-1');
    expect(mocks.createServiceClient).toHaveBeenCalledOnce();
    expect(mocks.collectBackendAlerts).toHaveBeenCalledWith({ service: 'supabase' });
    expect(body).toMatchObject({ status: 'ok', checkedAt: '2026-06-22T10:00:00.000Z' });
  });

  it('returns 503 when alerts are degraded', async () => {
    mocks.collectBackendAlerts.mockResolvedValueOnce({
      status: 'degraded',
      checkedAt: '2026-06-22T10:00:00.000Z',
      alerts: [
        {
          source: 'health',
          severity: 'degraded',
          code: 'GENERATION_STALLED_ACTIVE',
          message: 'stalled',
        },
      ],
    });

    const { GET } = await import('@/app/api/ops/backend-alerts/route');
    const response = await GET(new NextRequest('http://localhost/api/ops/backend-alerts', {
      headers: { authorization: 'Bearer secret-123' },
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: 'degraded',
      alerts: [expect.objectContaining({ code: 'GENERATION_STALLED_ACTIVE' })],
    });
  });

  it('returns 500 when alert collection fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.collectBackendAlerts.mockRejectedValueOnce(new Error('database unavailable'));

    const { GET } = await import('@/app/api/ops/backend-alerts/route');
    const response = await GET(new NextRequest('http://localhost/api/ops/backend-alerts', {
      headers: { authorization: 'Bearer secret-123', 'x-request-id': 'alerts-failed-1' },
    }));

    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('alerts-failed-1');
    await expect(response.json()).resolves.toMatchObject({
      status: 'degraded',
      error: 'Failed to collect backend alerts.',
    });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('backend_alerts_failed'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('alerts-failed-1'));
  });
});
