import { describe, expect, it, vi } from 'vitest';

import { buildBackendAlertSummary } from '@/lib/backend-alerts';
import type { BackendCostReport } from '@/lib/backend-cost-report';
import type { BackendHealth } from '@/lib/backend-health';
import type { BackendModerationHealth } from '@/lib/backend-moderation-health';
import {
  deliverBackendAlerts,
  hasConfiguredBackendAlertDelivery,
} from '@/lib/backend-alert-delivery';

const healthyBackend = {
  status: 'ok',
  checkedAt: '2026-06-23T10:00:00.000Z',
  buildId: 'build-123',
  issues: [],
} as unknown as BackendHealth;

const quietCosts = {
  status: 'ok',
  checkedAt: '2026-06-23T10:00:00.000Z',
  window: { recentHours: 24, since: '2026-06-22T10:00:00.000Z' },
  issues: [],
} as unknown as BackendCostReport;

const quietModeration = {
  status: 'ok',
  queue: {
    totalOpenCount: 0,
    oldestAgeMinutes: null,
  },
  issues: [],
} as unknown as BackendModerationHealth;

/**
 * `NodeJS.ProcessEnv` types NODE_ENV as required, so a bare `{}` or a
 * single-key object is not a valid env. These fixtures only care about the
 * alert-delivery URL, so this fills in the rest rather than asserting a
 * partial env the type does not allow.
 */
function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', ...overrides };
}

describe('backend alert delivery', () => {
  it('treats alert delivery as unconfigured without a destination URL', () => {
    expect(hasConfiguredBackendAlertDelivery(env())).toBe(false);
    expect(hasConfiguredBackendAlertDelivery(env({
      BACKEND_ALERT_DELIVERY_URL: ' https://alerts.example.com/hooks/backend ',
    }))).toBe(true);
  });

  it('does not post ok summaries by default', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const summary = buildBackendAlertSummary({
      health: healthyBackend,
      costs: quietCosts,
      moderation: quietModeration,
      checkedAt: '2026-06-23T10:01:00.000Z',
    });

    const result = await deliverBackendAlerts({ service: 'supabase' } as never, {
      collectAlerts: vi.fn(async () => summary),
      environment: env({
        BACKEND_ALERT_DELIVERY_URL: 'https://alerts.example.com/hooks/backend',
      }),
      fetcher,
    });

    expect(result).toMatchObject({
      configured: true,
      delivered: false,
      reason: 'no_alerts',
      alertStatus: 'ok',
      alertCount: 0,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('posts degraded summaries to the configured alert destination', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{}', { status: 202 }));
    const summary = buildBackendAlertSummary({
      health: {
        ...healthyBackend,
        status: 'degraded',
        issues: [{
          severity: 'degraded',
          code: 'JOB_STALE',
          message: 'backend-alert-delivery has not run recently.',
        }],
      },
      costs: quietCosts,
      moderation: quietModeration,
      checkedAt: '2026-06-23T10:02:00.000Z',
    });

    const result = await deliverBackendAlerts({ service: 'supabase' } as never, {
      collectAlerts: vi.fn(async () => summary),
      environment: env({
        BACKEND_ALERT_DELIVERY_URL: 'https://alerts.example.com/hooks/backend',
        BACKEND_ALERT_DELIVERY_AUTH_HEADER: 'Bearer alert-secret',
      }),
      fetcher: fetcher as unknown as typeof fetch,
    });

    expect(result).toMatchObject({
      configured: true,
      delivered: true,
      alertStatus: 'degraded',
      alertCount: 1,
      destinationHost: 'alerts.example.com',
      responseStatus: 202,
      dedupeKey: 'backend-alerts:degraded:JOB_STALE',
    });
    expect(fetcher).toHaveBeenCalledWith(
      'https://alerts.example.com/hooks/backend',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"backend_alerts"'),
      }),
    );
    const request = fetcher.mock.calls[0][1] as RequestInit;
    const headers = new Headers(request.headers);
    expect(headers.get('authorization')).toBe('Bearer alert-secret');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-magicbooklet-alert-status')).toBe('degraded');
    expect(headers.get('x-magicbooklet-alert-dedupe-key')).toBe('backend-alerts:degraded:JOB_STALE');
  });

  it('fails delivery when the destination returns an error status', async () => {
    const fetcher = vi.fn(async () => new Response('nope', { status: 500 }));
    const summary = buildBackendAlertSummary({
      health: {
        ...healthyBackend,
        status: 'warning',
        issues: [{
          severity: 'warning',
          code: 'PROVIDER_DEPENDENCY_FAILURES',
          message: 'Provider failures exceeded the warning threshold.',
        }],
      },
      costs: quietCosts,
      moderation: quietModeration,
      checkedAt: '2026-06-23T10:03:00.000Z',
    });

    await expect(deliverBackendAlerts({ service: 'supabase' } as never, {
      collectAlerts: vi.fn(async () => summary),
      environment: env({
        BACKEND_ALERT_DELIVERY_URL: 'https://alerts.example.com/hooks/backend',
      }),
      fetcher: fetcher as unknown as typeof fetch,
    })).rejects.toThrow('Backend alert delivery failed with status 500.');
  });
});
