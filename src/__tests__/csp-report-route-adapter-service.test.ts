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
    expect(oversizedRateLimit.enforceBackendRateLimit).not.toHaveBeenCalled();
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
    expect(rateLimit.enforceBackendRateLimit).not.toHaveBeenCalled();
    expect(logWarning).not.toHaveBeenCalled();
  });

  it('rejects an unsupported content type before any database work', async () => {
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
    expect(rateLimit.createServiceClient).not.toHaveBeenCalled();
    expect(rateLimit.enforceBackendRateLimit).not.toHaveBeenCalled();
    expect(logWarning).not.toHaveBeenCalled();
  });

  it.each([
    ['JSON that does not parse', '{invalid'],
    ['no report at all', '[1, 2]'],
    ['a report naming no directive', JSON.stringify({ 'csp-report': { 'blocked-uri': 'https://unexpected.example/x.js' } })],
    ['an empty object', '{}'],
  ])('rejects %s with 400 before any database work', async (_case, body) => {
    const logWarning = vi.fn();
    const rateLimit = allowedRateLimitDependencies();
    const response = await postCspReportRouteResponse({
      request: new Request('https://magicbooklet.com/api/security/csp-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/csp-report' },
        body,
      }),
      dependencies: { ...rateLimit, logWarning },
    });

    expect(response.status).toBe(400);
    expect(rateLimit.createServiceClient).not.toHaveBeenCalled();
    expect(rateLimit.enforceBackendRateLimit).not.toHaveBeenCalled();
    expect(logWarning).not.toHaveBeenCalled();
  });

  // The visitor's own add-ons trip the policy on every page they load; nothing
  // here can change them, and each report was a database write.
  it.each([
    ['an extension file it blocked (Chrome)', { 'blocked-uri': 'chrome-extension://abcdefghijklmnop/inject.js' }],
    ['an extension file it blocked (Firefox)', { 'blocked-uri': 'moz-extension://0a1b2c3d/content.css' }],
    ['an extension scheme reported alone', { 'blocked-uri': 'safari-web-extension' }],
    ['a Safari extension', { 'blocked-uri': 'safari-extension://com.example.ext/script.js' }],
    ["Safari's masked extension URL", { 'source-file': 'webkit-masked-url://hidden/' }],
    ['code an extension runs', { 'blocked-uri': 'eval', 'source-file': 'chrome-extension://abcdefghijklmnop/content.js' }],
    ['code running in an about:blank frame', { 'blocked-uri': 'inline', 'source-file': 'about:blank' }],
    ['code running in a data: document', { 'blocked-uri': 'inline', 'source-file': 'data' }],
    ['a Reporting API body from an extension', { blockedURL: 'CHROME-EXTENSION://abc/x.js', effectiveDirective: 'img-src' }],
  ])('drops %s with 204, logging and writing nothing', async (_case, fields) => {
    const logWarning = vi.fn();
    const rateLimit = allowedRateLimitDependencies();
    const isReportingApi = 'effectiveDirective' in fields;
    const response = await postCspReportRouteResponse({
      request: new Request('https://magicbooklet.com/api/security/csp-report', {
        method: 'POST',
        headers: { 'Content-Type': isReportingApi ? 'application/reports+json' : 'application/csp-report' },
        body: JSON.stringify(isReportingApi
          ? [{ type: 'csp-violation', body: { documentURL: 'https://magicbooklet.com/', ...fields } }]
          : {
              'csp-report': {
                'document-uri': 'https://magicbooklet.com/showcase',
                'effective-directive': 'script-src-elem',
                ...fields,
              },
            }),
      }),
      dependencies: { ...rateLimit, logWarning },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(rateLimit.createServiceClient).not.toHaveBeenCalled();
    expect(rateLimit.enforceBackendRateLimit).not.toHaveBeenCalled();
    expect(logWarning).not.toHaveBeenCalled();
  });

  // What an enforcing policy would break in the site's own code is the point
  // of the report stream: a data: or about: resource the page itself asked for.
  it.each([
    ['a data: resource the page asked for', { 'blocked-uri': 'data', 'source-file': 'https://magicbooklet.com/_next/static/chunks/app.js' }],
    ['an inline script on the page', { 'blocked-uri': 'inline', 'source-file': 'https://magicbooklet.com/showcase' }],
    ['an about: frame the page opened', { 'blocked-uri': 'about', 'effective-directive': 'frame-src' }],
    ['a third-party script', { 'blocked-uri': 'https://tracker.example/t.js' }],
  ])('keeps %s, charged to the rate limit and logged', async (_case, fields) => {
    const logWarning = vi.fn();
    const rateLimit = allowedRateLimitDependencies();
    const response = await postCspReportRouteResponse({
      request: new Request('https://magicbooklet.com/api/security/csp-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/csp-report' },
        body: JSON.stringify({
          'csp-report': {
            'document-uri': 'https://magicbooklet.com/showcase',
            'effective-directive': 'script-src-elem',
            ...fields,
          },
        }),
      }),
      dependencies: { ...rateLimit, logWarning },
    });

    expect(response.status).toBe(204);
    expect(rateLimit.enforceBackendRateLimit).toHaveBeenCalledTimes(1);
    expect(logWarning).toHaveBeenCalledTimes(1);
  });

  it('answers 429 to a report it would log once the network is over its limit', async () => {
    const logWarning = vi.fn();
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
        headers: { 'Content-Type': 'application/csp-report' },
        body: JSON.stringify({
          'csp-report': {
            'document-uri': 'https://magicbooklet.com/',
            'blocked-uri': 'https://unexpected.example/track.js',
            'effective-directive': 'script-src-elem',
          },
        }),
      }),
      dependencies: {
        createServiceClient: vi.fn(() => ({}) as SupabaseClient),
        enforceBackendRateLimit: vi.fn(async () => { throw rateLimitError; }),
        getRateLimitKey: vi.fn(() => '203.0.113.10'),
        logWarning,
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('45');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(logWarning).not.toHaveBeenCalled();
  });

  it('answers 500 and logs nothing as a violation when the limit cannot be checked', async () => {
    const logWarning = vi.fn();
    const logError = vi.fn();

    const response = await postCspReportRouteResponse({
      request: new Request('https://magicbooklet.com/api/security/csp-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/csp-report' },
        body: JSON.stringify({
          'csp-report': { 'blocked-uri': 'https://unexpected.example/track.js', 'violated-directive': 'script-src' },
        }),
      }),
      dependencies: {
        createServiceClient: vi.fn(() => ({}) as SupabaseClient),
        enforceBackendRateLimit: vi.fn(async () => { throw new Error('database offline'); }),
        getRateLimitKey: vi.fn(() => '203.0.113.10'),
        logError,
        logWarning,
      },
    });

    expect(response.status).toBe(500);
    expect(logError).toHaveBeenCalledWith('CSP report rate limit failed:', expect.any(Error));
    expect(logWarning).not.toHaveBeenCalled();
  });
});
