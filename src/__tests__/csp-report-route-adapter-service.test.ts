import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import {
  MAX_CSP_REPORT_BYTES,
  postCspReportRouteResponse,
} from '@/lib/csp-report-route-adapter-service';

function allowedRateLimitDependencies() {
  const enforceBackendRateLimit = vi.fn(async () => ({
    allowed: true,
    limit: 120,
    remaining: 119,
    retryAfterSeconds: 0,
    resetAt: '2026-08-19T12:00:00.000Z',
  }));
  return {
    createServiceClient: vi.fn(() => ({}) as SupabaseClient),
    enforceBackendRateLimit,
    getRateLimitKey: vi.fn(() => '203.0.113.10'),
  };
}

describe('CSP report route adapter', () => {
  it('accepts legacy browser reports and strips URL query data before logging', async () => {
    const logWarning = vi.fn();
    const rateLimit = allowedRateLimitDependencies();
    const response = await postCspReportRouteResponse({
      request: new Request('https://magicbooklet.com/api/security/csp-report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/csp-report',
          'User-Agent': 'Test Browser',
        },
        body: JSON.stringify({
          'csp-report': {
            'document-uri': 'https://magicbooklet.com/create?access_token=secret',
            'blocked-uri': 'https://unexpected.example/track.js?token=secret',
            'effective-directive': 'script-src-elem',
          },
        }),
      }),
      dependencies: { ...rateLimit, logWarning },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(logWarning).toHaveBeenCalledWith('content_security_policy_violation', expect.objectContaining({
      blockedResource: 'https://unexpected.example/track.js',
      document: 'https://magicbooklet.com/create',
      effectiveDirective: 'script-src-elem',
    }));
    expect(JSON.stringify(logWarning.mock.calls)).not.toContain('secret');
    expect(rateLimit.enforceBackendRateLimit).toHaveBeenCalledWith(expect.anything(), {
      scope: 'security:csp-report',
      key: '203.0.113.10',
      limit: 120,
      windowSeconds: 600,
    });
  });

  it('accepts Reporting API arrays and rejects oversized reports', async () => {
    const logWarning = vi.fn();
    const acceptedRateLimit = allowedRateLimitDependencies();
    const accepted = await postCspReportRouteResponse({
      request: new Request('https://magicbooklet.com/api/security/csp-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/reports+json' },
        body: JSON.stringify([{
          type: 'csp-violation',
          body: {
            documentURL: 'https://magicbooklet.com/',
            blockedURL: 'inline',
            effectiveDirective: 'script-src-elem',
          },
        }]),
      }),
      dependencies: { ...acceptedRateLimit, logWarning },
    });
    expect(accepted.status).toBe(204);

    const oversizedRateLimit = allowedRateLimitDependencies();
    const oversized = await postCspReportRouteResponse({
      request: new Request('https://magicbooklet.com/api/security/csp-report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/csp-report',
          'Content-Length': String(20 * 1024),
        },
        body: '{}',
      }),
      dependencies: { ...oversizedRateLimit, logWarning },
    });
    expect(oversized.status).toBe(413);
    expect(oversizedRateLimit.enforceBackendRateLimit).toHaveBeenCalledTimes(1);
  });

  it('aborts an oversized stream without relying on Content-Length', async () => {
    const logWarning = vi.fn();
    const rateLimit = allowedRateLimitDependencies();
    const request = new Request('https://magicbooklet.com/api/security/csp-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/csp-report' },
      body: JSON.stringify({ padding: 'x'.repeat(MAX_CSP_REPORT_BYTES) }),
    });
    expect(request.headers.has('content-length')).toBe(false);

    const response = await postCspReportRouteResponse({
      request,
      dependencies: { ...rateLimit, logWarning },
    });

    expect(response.status).toBe(413);
    expect(rateLimit.enforceBackendRateLimit).toHaveBeenCalledTimes(1);
    expect(logWarning).not.toHaveBeenCalled();
  });

  it('rejects malformed or unsupported payloads without logging them', async () => {
    const logWarning = vi.fn();
    const rateLimit = allowedRateLimitDependencies();
    const response = await postCspReportRouteResponse({
      request: new Request('https://magicbooklet.com/api/security/csp-report', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: '{}',
      }),
      dependencies: { ...rateLimit, logWarning },
    });
    expect(response.status).toBe(415);
    expect(rateLimit.enforceBackendRateLimit).toHaveBeenCalledTimes(1);
    expect(logWarning).not.toHaveBeenCalled();
  });

  it('charges malformed report JSON before returning 400', async () => {
    const logWarning = vi.fn();
    const rateLimit = allowedRateLimitDependencies();
    const response = await postCspReportRouteResponse({
      request: new Request('https://magicbooklet.com/api/security/csp-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/csp-report' },
        body: '{invalid',
      }),
      dependencies: { ...rateLimit, logWarning },
    });

    expect(response.status).toBe(400);
    expect(rateLimit.enforceBackendRateLimit).toHaveBeenCalledTimes(1);
    expect(logWarning).not.toHaveBeenCalled();
  });

  it('returns a rate-limit response before content checks or body parsing', async () => {
    const readBoundedJsonBody = vi.fn();
    const rateLimitError = new BackendRateLimitError({
      allowed: false,
      limit: 120,
      remaining: 0,
      retryAfterSeconds: 45,
      resetAt: '2026-08-19T12:00:00.000Z',
    });

    const response = await postCspReportRouteResponse({
      request: new Request('https://magicbooklet.com/api/security/csp-report', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: '{invalid',
      }),
      dependencies: {
        createServiceClient: vi.fn(() => ({}) as SupabaseClient),
        enforceBackendRateLimit: vi.fn(async () => { throw rateLimitError; }),
        getRateLimitKey: vi.fn(() => '203.0.113.10'),
        readBoundedJsonBody,
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('45');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(readBoundedJsonBody).not.toHaveBeenCalled();
  });
});
