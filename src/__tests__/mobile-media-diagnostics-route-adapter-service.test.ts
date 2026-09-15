import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import {
  MAX_MEDIA_DIAGNOSTIC_EVENTS,
  postMobileMediaDiagnosticsRouteResponse,
} from '@/lib/mobile-media-diagnostics-route-adapter-service';

const endpoint = 'https://magicbooklet.com/api/mobile/media-diagnostics';

function allowedRateLimit() {
  return {
    createServiceClient: vi.fn(() => ({}) as SupabaseClient),
    enforceBackendRateLimit: vi.fn(async () => ({
      allowed: true,
      limit: 30,
      remaining: 29,
      retryAfterSeconds: 0,
      resetAt: '2026-09-16T12:00:00.000Z',
    })),
    getRateLimitKey: vi.fn(() => '203.0.113.10'),
  };
}

function stall(overrides: Record<string, unknown> = {}) {
  return {
    at: Date.parse('2026-09-16T10:00:00.000Z'),
    kind: 'image',
    event: 'stall',
    surface: 'profile-grid',
    subject: '8a1f09c2',
    attempt: 0,
    stage: 'no-response',
    ...overrides,
  };
}

function report(body: unknown, headers: Record<string, string> = { 'Content-Type': 'application/json' }) {
  return new Request(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
}

describe('mobile media diagnostics route adapter', () => {
  it('logs a well-formed sample and answers with no content', async () => {
    const logWarning = vi.fn();
    const rateLimit = allowedRateLimit();

    const response = await postMobileMediaDiagnosticsRouteResponse({
      request: report({
        sessionId: 'a1b2c3d4-e5f6',
        app: { version: '0.1.4', build: '71', update: '0558882d' },
        events: [stall(), stall({ event: 'latched', attempt: 2, stage: 'stalled' })],
      }),
      dependencies: { ...rateLimit, logWarning },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(rateLimit.enforceBackendRateLimit).toHaveBeenCalledWith(expect.anything(), {
      scope: 'mobile:media-diagnostics',
      key: '203.0.113.10',
      limit: 30,
      windowSeconds: 600,
    });
    expect(logWarning).toHaveBeenCalledWith('mobile_media_diagnostics', expect.objectContaining({
      sessionId: 'a1b2c3d4-e5f6',
      appVersion: '0.1.4',
      appBuild: '71',
      appUpdate: '0558882d',
      stalls: 1,
      failures: 1,
      events: [
        expect.objectContaining({ at: '2026-09-16T10:00:00.000Z', subject: '8a1f09c2', stage: 'no-response' }),
        expect.objectContaining({ event: 'latched', attempt: 2 }),
      ],
    }));
  });

  it.each([
    ['an address in place of a hashed subject', { events: [stall({ subject: 'https://storage.example/a.webp?token=secret' })] }],
    ['free text in a stage', { events: [stall({ stage: 'Failed https://storage.example/a.webp?token=secret' })] }],
    ['an unknown event name', { events: [stall({ event: 'prompt' })] }],
    ['a status outside 4xx and 5xx', { events: [stall({ status: 200 })] }],
    ['no events', { events: [] }],
    ['too many events', { events: Array.from({ length: MAX_MEDIA_DIAGNOSTIC_EVENTS + 1 }, () => stall()) }],
    ['a malformed session id', { sessionId: 'not a session', events: [stall()] }],
  ])('rejects %s without logging anything', async (_label, overrides) => {
    const logWarning = vi.fn();

    const response = await postMobileMediaDiagnosticsRouteResponse({
      request: report({ sessionId: 'a1b2c3d4-e5f6', app: {}, ...overrides }),
      dependencies: { ...allowedRateLimit(), logWarning },
    });

    expect(response.status).toBe(400);
    expect(logWarning).not.toHaveBeenCalled();
  });

  it('refuses other content types and oversized bodies after charging the rate limit', async () => {
    const rateLimit = allowedRateLimit();
    const unsupported = await postMobileMediaDiagnosticsRouteResponse({
      request: report({ sessionId: 'a1b2c3d4-e5f6', events: [stall()] }, { 'Content-Type': 'text/plain' }),
      dependencies: rateLimit,
    });
    expect(unsupported.status).toBe(415);

    const oversized = await postMobileMediaDiagnosticsRouteResponse({
      request: new Request(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': String(64 * 1024) },
        body: '{}',
      }),
      dependencies: rateLimit,
    });
    expect(oversized.status).toBe(413);
    expect(rateLimit.enforceBackendRateLimit).toHaveBeenCalledTimes(2);
  });

  it('answers a rate-limited sender before reading its body', async () => {
    const readBoundedJsonBody = vi.fn();
    const response = await postMobileMediaDiagnosticsRouteResponse({
      request: report({ sessionId: 'a1b2c3d4-e5f6', events: [stall()] }),
      dependencies: {
        createServiceClient: vi.fn(() => ({}) as SupabaseClient),
        enforceBackendRateLimit: vi.fn(async () => {
          throw new BackendRateLimitError({
            allowed: false,
            limit: 30,
            remaining: 0,
            retryAfterSeconds: 120,
            resetAt: '2026-09-16T12:00:00.000Z',
          });
        }),
        getRateLimitKey: vi.fn(() => '203.0.113.10'),
        readBoundedJsonBody,
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('120');
    expect(readBoundedJsonBody).not.toHaveBeenCalled();
  });
});
