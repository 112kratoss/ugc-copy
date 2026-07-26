import { describe, expect, it, vi } from 'vitest';

import { postCspReportRouteResponse } from '@/lib/csp-report-route-adapter-service';

describe('CSP report route adapter', () => {
  it('accepts legacy browser reports and strips URL query data before logging', async () => {
    const logWarning = vi.fn();
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
      dependencies: { logWarning },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(logWarning).toHaveBeenCalledWith('content_security_policy_violation', expect.objectContaining({
      blockedResource: 'https://unexpected.example/track.js',
      document: 'https://magicbooklet.com/create',
      effectiveDirective: 'script-src-elem',
    }));
    expect(JSON.stringify(logWarning.mock.calls)).not.toContain('secret');
  });

  it('accepts Reporting API arrays and rejects oversized reports', async () => {
    const logWarning = vi.fn();
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
      dependencies: { logWarning },
    });
    expect(accepted.status).toBe(204);

    const oversized = await postCspReportRouteResponse({
      request: new Request('https://magicbooklet.com/api/security/csp-report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/csp-report',
          'Content-Length': String(20 * 1024),
        },
        body: '{}',
      }),
      dependencies: { logWarning },
    });
    expect(oversized.status).toBe(413);
  });

  it('rejects malformed or unsupported payloads without logging them', async () => {
    const logWarning = vi.fn();
    const response = await postCspReportRouteResponse({
      request: new Request('https://magicbooklet.com/api/security/csp-report', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: '{}',
      }),
      dependencies: { logWarning },
    });
    expect(response.status).toBe(415);
    expect(logWarning).not.toHaveBeenCalled();
  });
});
