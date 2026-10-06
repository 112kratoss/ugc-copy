import { expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import operations from '../../contracts/mobile-api-operations-v1.json';
import { postMobileMediaDiagnosticsRouteResponse } from '@/lib/mobile-media-diagnostics-route-adapter-service';

it('returns the shared invalid-timestamp response without throwing or logging the report', async () => {
  const operation = operations.operations.reportMediaDiagnostics;
  const fixture = operation.invalidTimestamp;
  const logWarning = vi.fn();
  const response = await postMobileMediaDiagnosticsRouteResponse({
    request: new Request('http://audit.local' + operation.path, {
      method: operation.method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fixture.request),
    }),
    dependencies: {
      createServiceClient: () => ({} as SupabaseClient),
      enforceBackendRateLimit: async () => ({ allowed: true, limit: 30, remaining: 29, retryAfterSeconds: 0, resetAt: '2026-10-06T00:00:00.000Z' }),
      logWarning,
    },
  });
  expect(response.status).toBe(fixture.status);
  expect(response.headers.get('Cache-Control')).toBe(fixture.cacheControl);
  expect(await response.json()).toEqual(fixture.response);
  expect(logWarning).not.toHaveBeenCalled();
});
