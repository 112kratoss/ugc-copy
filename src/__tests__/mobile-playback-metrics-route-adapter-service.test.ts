import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import {
  MAX_PLAYBACK_METRICS_SAMPLES,
  parsePlaybackMetricsReport,
  postMobilePlaybackMetricsRouteResponse,
} from '@/lib/mobile-playback-metrics-route-adapter-service';

const endpoint = 'https://magicbooklet.com/api/mobile/playback-metrics';

function serviceClient(insertResult: { error: unknown } = { error: null }) {
  const insert = vi.fn(async (_rows: unknown) => insertResult);
  const from = vi.fn(() => ({ insert }));
  return { client: { from } as unknown as SupabaseClient, from, insert };
}

function allowedRateLimit(client: SupabaseClient) {
  return {
    createServiceClient: vi.fn(() => client),
    enforceBackendRateLimit: vi.fn(async () => ({
      allowed: true,
      limit: 30,
      remaining: 29,
      retryAfterSeconds: 0,
      resetAt: '2026-09-19T12:00:00.000Z',
    })),
    getRateLimitKey: vi.fn(() => '203.0.113.10'),
  };
}

function bucket(overrides: Record<string, unknown> = {}) {
  return {
    surface: 'viewer',
    kind: 'warm',
    starts: 3,
    startTotalMs: 210,
    startMaxMs: 120,
    samples: [40, 50, 120],
    stalls: 1,
    stallTotalMs: 800,
    stallMaxMs: 800,
    ...overrides,
  };
}

function report(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'a1b2c3d4-e5f6',
    app: { version: '0.1.4', build: '72', update: '0558882d' },
    device: { platform: 'android', os: '15', model: 'samsung SM-S928B', network: 'wifi' },
    spanMs: 65_000,
    buckets: [bucket(), bucket({ surface: 'feed', kind: 'cold', stalls: 0, stallTotalMs: 0, stallMaxMs: 0 })],
    ...overrides,
  };
}

function post(body: unknown, headers: Record<string, string> = { 'Content-Type': 'application/json' }) {
  return new Request(endpoint, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

describe('parsePlaybackMetricsReport', () => {
  it('turns a well-formed report into one row per bucket', () => {
    const rows = parsePlaybackMetricsReport(report());

    expect(rows).toEqual([
      {
        session_id: 'a1b2c3d4-e5f6',
        platform: 'android',
        os_version: '15',
        device_model: 'samsung SM-S928B',
        network: 'wifi',
        app_version: '0.1.4',
        app_build: '72',
        app_update: '0558882d',
        span_ms: 65_000,
        surface: 'viewer',
        start_kind: 'warm',
        starts: 3,
        start_total_ms: 210,
        start_max_ms: 120,
        start_samples: [40, 50, 120],
        stalls: 1,
        stall_total_ms: 800,
        stall_max_ms: 800,
      },
      expect.objectContaining({ surface: 'feed', start_kind: 'cold', stalls: 0 }),
    ]);
  });

  it('accepts a report with no model and no update, as a store build without one sends', () => {
    const rows = parsePlaybackMetricsReport(report({
      app: { version: '0.1.4', build: '72', update: null },
      device: { platform: 'ios', os: '26.0', model: null, network: 'unknown' },
    }));

    expect(rows?.[0]).toEqual(expect.objectContaining({ device_model: null, app_update: null, platform: 'ios', network: 'unknown' }));
  });

  it.each([
    ['a session id outside the pattern', report({ sessionId: 'short' })],
    ['an unknown platform', report({ device: { platform: 'web', os: '1', model: null, network: 'wifi' } })],
    ['an unknown network', report({ device: { platform: 'ios', os: '26.0', model: null, network: 'satellite' } })],
    ['an address in the model field', report({ device: { platform: 'ios', os: '26.0', model: 'https://example.com/x', network: 'wifi' } })],
    ['a negative span', report({ spanMs: -1 })],
    ['no buckets', report({ buckets: [] })],
    ['five buckets', report({ buckets: [bucket(), bucket(), bucket(), bucket(), bucket()] })],
    ['two buckets for the same surface and kind', report({ buckets: [bucket(), bucket()] })],
    ['an unknown surface', report({ buckets: [bucket({ surface: 'lightbox' })] })],
    ['an unknown start kind', report({ buckets: [bucket({ kind: 'hot' })] })],
    ['a fractional start count', report({ buckets: [bucket({ starts: 1.5 })] })],
    ['more samples than starts', report({ buckets: [bucket({ starts: 2 })] })],
    ['too many samples', report({ buckets: [bucket({ starts: 40, samples: Array.from({ length: MAX_PLAYBACK_METRICS_SAMPLES + 1 }, () => 10) })] })],
    ['a sample beyond any measured start', report({ buckets: [bucket({ samples: [40, 50, 1_000_000] })] })],
    ['an empty bucket', report({ buckets: [bucket({ starts: 0, startTotalMs: 0, startMaxMs: 0, samples: [], stalls: 0, stallTotalMs: 0, stallMaxMs: 0 })] })],
    ['a string where a number belongs', report({ buckets: [bucket({ stallTotalMs: '800' })] })],
    ['a body that is not an object', 'metrics'],
  ])('refuses %s', (_label, body) => {
    expect(parsePlaybackMetricsReport(body)).toBeNull();
  });
});

describe('mobile playback metrics route adapter', () => {
  it('stores a well-formed report and answers with no content', async () => {
    const { client, from, insert } = serviceClient();
    const rateLimit = allowedRateLimit(client);

    const response = await postMobilePlaybackMetricsRouteResponse({
      request: post(report()),
      dependencies: rateLimit,
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(rateLimit.enforceBackendRateLimit).toHaveBeenCalledWith(client, {
      scope: 'mobile:playback-metrics',
      limit: 30,
      windowSeconds: 600,
      key: '203.0.113.10',
    });
    expect(from).toHaveBeenCalledWith('playback_metrics');
    expect(insert).toHaveBeenCalledTimes(1);
    expect((insert.mock.calls[0] as unknown[])[0]).toHaveLength(2);
  });

  it('refuses a malformed report without touching the table', async () => {
    const { client, insert } = serviceClient();

    const response = await postMobilePlaybackMetricsRouteResponse({
      request: post(report({ buckets: [bucket({ surface: 'lightbox' })] })),
      dependencies: allowedRateLimit(client),
    });

    expect(response.status).toBe(400);
    expect(insert).not.toHaveBeenCalled();
  });

  it('refuses a body that is not JSON', async () => {
    const { client } = serviceClient();

    const response = await postMobilePlaybackMetricsRouteResponse({
      request: post('starts=3', { 'Content-Type': 'text/plain' }),
      dependencies: allowedRateLimit(client),
    });

    expect(response.status).toBe(415);
  });

  it('answers 429 from the rate limit', async () => {
    const { client, insert } = serviceClient();
    const rateLimit = allowedRateLimit(client);
    rateLimit.enforceBackendRateLimit = vi.fn(async () => {
      throw new BackendRateLimitError({ allowed: false, limit: 30, remaining: 0, retryAfterSeconds: 42, resetAt: '2026-09-19T12:00:00.000Z' });
    });

    const response = await postMobilePlaybackMetricsRouteResponse({
      request: post(report()),
      dependencies: rateLimit,
    });

    expect(response.status).toBe(429);
    expect(insert).not.toHaveBeenCalled();
  });

  it('reports a failed insert as a server error', async () => {
    const { client } = serviceClient({ error: { message: 'relation missing' } });
    const logError = vi.fn();

    const response = await postMobilePlaybackMetricsRouteResponse({
      request: post(report()),
      dependencies: { ...allowedRateLimit(client), logError },
    });

    expect(response.status).toBe(500);
    expect(logError).toHaveBeenCalledWith('Playback metrics insert failed:', { message: 'relation missing' });
  });
});
