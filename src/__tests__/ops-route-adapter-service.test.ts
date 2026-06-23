import { describe, expect, it, vi } from 'vitest';

import {
  createProtectedOpsRouteHandlers,
  getProtectedOpsRouteResponse,
} from '@/lib/ops-route-adapter-service';

describe('ops route adapter service', () => {
  it('rejects unauthorized requests before creating Supabase clients or collecting metrics', async () => {
    const createServiceClient = vi.fn();
    const collect = vi.fn();

    const response = await getProtectedOpsRouteResponse({
      request: new Request('http://localhost/api/ops/backend-health', {
        headers: { 'x-request-id': 'ops-adapter-unauthorized-1' },
      }),
      collect,
      failureLogMessage: 'backend_health_failed',
      failureResponseError: 'Failed to collect backend health.',
      dependencies: {
        createServiceClient,
        isAuthorizedOpsRequest: () => false,
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('ops-adapter-unauthorized-1');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(collect).not.toHaveBeenCalled();
  });

  it('delegates authorized checks with private headers and maps healthy payloads to 200', async () => {
    const serviceClient = { service: 'supabase' };
    const collect = vi.fn(async () => ({
      status: 'ok',
      checkedAt: '2026-06-23T10:00:00.000Z',
      issues: [],
    }));

    const response = await getProtectedOpsRouteResponse({
      request: new Request('http://localhost/api/ops/backend-costs', {
        headers: { 'x-request-id': 'ops-adapter-ok-1' },
      }),
      collect,
      failureLogMessage: 'backend_cost_report_failed',
      failureResponseError: 'Failed to collect backend cost report.',
      dependencies: {
        createServiceClient: vi.fn(() => serviceClient),
        isAuthorizedOpsRequest: () => true,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('ops-adapter-ok-1');
    await expect(response.json()).resolves.toMatchObject({ status: 'ok' });
    expect(collect).toHaveBeenCalledWith(serviceClient);
  });

  it('maps degraded operational payloads to 503 without changing the body', async () => {
    const collect = vi.fn(async () => ({
      status: 'degraded',
      alerts: [{ code: 'QUOTE_PRESSURE_SPIKE', message: 'quote pressure' }],
    }));

    const response = await getProtectedOpsRouteResponse({
      request: new Request('http://localhost/api/ops/backend-alerts'),
      collect,
      failureLogMessage: 'backend_alerts_failed',
      failureResponseError: 'Failed to collect backend alerts.',
      dependencies: {
        createServiceClient: vi.fn(() => ({ service: 'supabase' })),
        isAuthorizedOpsRequest: () => true,
      },
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: 'degraded',
      alerts: [expect.objectContaining({ code: 'QUOTE_PRESSURE_SPIKE' })],
    });
  });

  it('logs collector failures with the request id and returns a stable degraded response', async () => {
    const logError = vi.fn();
    const collect = vi.fn(async () => {
      throw new Error('database unavailable');
    });

    const response = await getProtectedOpsRouteResponse({
      request: new Request('http://localhost/api/ops/backend-health', {
        headers: { 'x-request-id': 'ops-adapter-failed-1' },
      }),
      collect,
      failureLogMessage: 'backend_health_failed',
      failureResponseError: 'Failed to collect backend health.',
      dependencies: {
        createServiceClient: vi.fn(() => ({ service: 'supabase' })),
        isAuthorizedOpsRequest: () => true,
        logError,
      },
    });

    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('ops-adapter-failed-1');
    await expect(response.json()).resolves.toEqual({
      status: 'degraded',
      error: 'Failed to collect backend health.',
    });
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('backend_health_failed'));
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('ops-adapter-failed-1'));
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('database unavailable'));
  });

  it('logs structured collector failure details instead of opaque object strings', async () => {
    const logError = vi.fn();
    const collect = vi.fn(async () => {
      throw {
        code: 'PGRST106',
        message: 'Invalid schema: storage',
      };
    });

    const response = await getProtectedOpsRouteResponse({
      request: new Request('http://localhost/api/ops/backend-costs', {
        headers: { 'x-request-id': 'ops-adapter-storage-schema-1' },
      }),
      collect,
      failureLogMessage: 'backend_cost_report_failed',
      failureResponseError: 'Failed to collect backend cost report.',
      dependencies: {
        createServiceClient: vi.fn(() => ({ service: 'supabase' })),
        isAuthorizedOpsRequest: () => true,
        logError,
      },
    });

    expect(response.status).toBe(500);
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('PGRST106'));
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('Invalid schema: storage'));
    expect(logError).not.toHaveBeenCalledWith(expect.stringContaining('[object Object]'));
  });

  it('creates protected GET handlers that forward requests through the ops adapter', async () => {
    const serviceClient = { service: 'supabase' };
    const collect = vi.fn(async () => ({
      status: 'ok',
      checkedAt: '2026-06-23T11:00:00.000Z',
      issues: [],
    }));
    const { GET } = createProtectedOpsRouteHandlers({
      collect,
      failureLogMessage: 'backend_health_failed',
      failureResponseError: 'Failed to collect backend health.',
      dependencies: {
        createServiceClient: vi.fn(() => serviceClient),
        isAuthorizedOpsRequest: () => true,
      },
    });

    const response = await GET(new Request('http://localhost/api/ops/backend-health', {
      headers: { 'x-request-id': 'ops-adapter-factory-1' },
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('ops-adapter-factory-1');
    await expect(response.json()).resolves.toMatchObject({ status: 'ok' });
    expect(collect).toHaveBeenCalledWith(serviceClient);
  });
});
