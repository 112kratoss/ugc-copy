import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  collectBackendCostReport: vi.fn(),
  createServiceClient: vi.fn(),
}));

vi.mock('@/lib/backend-cost-report', () => ({
  collectBackendCostReport: (...args: unknown[]) => mocks.collectBackendCostReport(...args),
}));

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: (...args: unknown[]) => mocks.createServiceClient(...args),
}));

describe('/api/ops/backend-costs route', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.collectBackendCostReport.mockReset();
    mocks.createServiceClient.mockReset();
    mocks.createServiceClient.mockReturnValue({ service: 'supabase' });
    mocks.collectBackendCostReport.mockResolvedValue({
      status: 'ok',
      checkedAt: '2026-06-22T10:00:00.000Z',
      window: { recentHours: 24, since: '2026-06-21T10:00:00.000Z' },
      generationSpend: { recentRuns: 0, recentCreditCost: 0 },
      aiUsageSpend: { recentEvents: 0, recentCreditCost: 0 },
      providerDependencies: { recentEvents: 0 },
      storageGrowth: { recentObjectCount: 0, recentBytes: 0 },
      rateLimitPressure: { totalRequests: 0, quoteRequests: 0, mediaReadRequests: 0 },
      issues: [],
    });
    process.env.CRON_SECRET = 'secret-123';
  });

  it('rejects unauthorized cost report requests before touching Supabase', async () => {
    const { GET } = await import('@/app/api/ops/backend-costs/route');
    const response = await GET(new NextRequest('http://localhost/api/ops/backend-costs', {
      headers: { 'x-request-id': 'costs-unauthorized-1' },
    }));

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('costs-unauthorized-1');
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.collectBackendCostReport).not.toHaveBeenCalled();
  });

  it('returns a no-store cost report for authorized ops checks', async () => {
    const { GET } = await import('@/app/api/ops/backend-costs/route');
    const response = await GET(new NextRequest('http://localhost/api/ops/backend-costs', {
      headers: { authorization: 'Bearer secret-123', 'x-request-id': 'costs-ok-1' },
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('costs-ok-1');
    expect(mocks.createServiceClient).toHaveBeenCalledOnce();
    expect(mocks.collectBackendCostReport).toHaveBeenCalledWith({ service: 'supabase' });
    expect(body).toMatchObject({ status: 'ok', checkedAt: '2026-06-22T10:00:00.000Z' });
  });

  it('returns 503 for degraded cost reports', async () => {
    mocks.collectBackendCostReport.mockResolvedValueOnce({
      status: 'degraded',
      checkedAt: '2026-06-22T10:00:00.000Z',
      issues: [{ severity: 'degraded', code: 'QUOTE_PRESSURE_SPIKE', message: 'quote pressure' }],
    });

    const { GET } = await import('@/app/api/ops/backend-costs/route');
    const response = await GET(new NextRequest('http://localhost/api/ops/backend-costs', {
      headers: { authorization: 'Bearer secret-123' },
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: 'degraded',
      issues: [expect.objectContaining({ code: 'QUOTE_PRESSURE_SPIKE' })],
    });
  });

  it('returns 500 when cost report collection fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.collectBackendCostReport.mockRejectedValueOnce(new Error('database unavailable'));

    const { GET } = await import('@/app/api/ops/backend-costs/route');
    const response = await GET(new NextRequest('http://localhost/api/ops/backend-costs', {
      headers: { authorization: 'Bearer secret-123', 'x-request-id': 'costs-failed-1' },
    }));

    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('costs-failed-1');
    await expect(response.json()).resolves.toMatchObject({
      status: 'degraded',
      error: 'Failed to collect backend cost report.',
    });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('backend_cost_report_failed'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('costs-failed-1'));
  });
});
