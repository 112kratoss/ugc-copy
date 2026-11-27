import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import mobileApiContract from '../../contracts/mobile-api-v1.json';
import operations from '../../contracts/mobile-api-operations-v1.json';
import {
  BackendRateLimitError,
  MOBILE_CLIENT_ERRORS_DAILY_CAP,
  MOBILE_CLIENT_ERRORS_RATE_LIMIT,
} from '@/lib/backend-rate-limit';
import { parseMobileClientErrorReport } from '@/lib/mobile-client-errors';
import {
  MAX_MOBILE_CLIENT_ERROR_BYTES,
  postMobileClientErrorsRouteResponse,
} from '@/lib/mobile-client-errors-route-adapter-service';
import { routeIdentityPolicy } from '@/lib/route-identity-policy';

// Audit 2026-11-27: errors on phones reached nobody. The app's own reporter (no vendor) sends what
// its error boundary, global handler and rejection tracker catch here, and the row is kept 30 days.
const contract = mobileApiContract.endpoints.reportClientError;

function insertingClient(options: { error?: unknown } = {}) {
  const inserted: Array<Record<string, unknown>> = [];
  const client = {
    from: vi.fn((table: string) => ({
      insert: vi.fn(async (row: Record<string, unknown>) => {
        inserted.push({ table, ...row });
        return { error: options.error ?? null };
      }),
    })),
  };
  return { client: client as unknown as SupabaseClient, inserted };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/mobile/client-errors', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function dependencies(overrides: Partial<NonNullable<Parameters<typeof postMobileClientErrorsRouteResponse>[0]['dependencies']>> = {}) {
  const admin = insertingClient();
  return {
    admin,
    deps: {
      createServiceClient: () => admin.client,
      enforceBackendRateLimit: vi.fn(async () => ({ allowed: true, limit: 20, remaining: 19, retryAfterSeconds: 0, resetAt: '2026-11-27T10:10:00.000Z' })),
      getRateLimitKey: () => 'network-1',
      getOptionalUserId: vi.fn(async () => null),
      logError: vi.fn(),
      ...overrides,
    },
  };
}

describe('POST /api/mobile/client-errors', () => {
  it('is admitted for guests and accounts alike, as the contract says', () => {
    expect(routeIdentityPolicy('/api/mobile/client-errors')).toBe('public');
    expect(operations.operations.reportClientError).toEqual({ method: 'POST', path: '/api/mobile/client-errors', auth: 'optional' });
    expect(contract.path).toBe('/api/mobile/client-errors');
  });

  it('stores the contract\'s report, answering 204 with nothing', async () => {
    const { admin, deps } = dependencies({ getOptionalUserId: vi.fn(async () => 'user-1') });
    const response = await postMobileClientErrorsRouteResponse({
      request: post(contract.request, { authorization: 'Bearer token' }),
      dependencies: deps,
    });

    expect(response.status).toBe(contract.status);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(admin.inserted).toEqual([{
      table: 'mobile_client_errors',
      user_id: 'user-1',
      platform: contract.request.platform,
      app_version: contract.request.appVersion,
      update_id: contract.request.updateId,
      route: contract.request.route,
      fatal: contract.request.fatal,
      message: contract.request.message,
      stack: contract.request.stack,
      component_stack: contract.request.componentStack,
    }]);
    // A signed-in report is limited by its account, so people behind one network are not one budget.
    expect(deps.enforceBackendRateLimit).toHaveBeenCalledWith(admin.client, { ...MOBILE_CLIENT_ERRORS_RATE_LIMIT, key: 'user:user-1' });
    expect(deps.enforceBackendRateLimit).toHaveBeenCalledWith(admin.client, { ...MOBILE_CLIENT_ERRORS_DAILY_CAP, key: 'all' });
  });

  it('limits a guest\'s report by its network', async () => {
    const { deps } = dependencies();
    await postMobileClientErrorsRouteResponse({ request: post(contract.request), dependencies: deps });
    expect(deps.enforceBackendRateLimit).toHaveBeenCalledWith(expect.anything(), { ...MOBILE_CLIENT_ERRORS_RATE_LIMIT, key: 'network:network-1' });
  });

  // Many addresses must not fill the table: past the day's cap a report is dropped quietly.
  it('drops a report past the global daily cap with a 204, storing nothing', async () => {
    const full = new BackendRateLimitError({ allowed: false, limit: 5000, remaining: 0, retryAfterSeconds: 600, resetAt: '2026-11-28T00:00:00.000Z' });
    const { admin, deps } = dependencies({
      enforceBackendRateLimit: vi.fn(async (_client: unknown, options: { scope: string }) => {
        if (options.scope === MOBILE_CLIENT_ERRORS_DAILY_CAP.scope) throw full;
        return { allowed: true, limit: 20, remaining: 19, retryAfterSeconds: 0, resetAt: '2026-11-27T10:10:00.000Z' };
      }) as never,
    });
    const response = await postMobileClientErrorsRouteResponse({ request: post(contract.request), dependencies: deps });
    expect(response.status).toBe(204);
    expect(admin.inserted).toEqual([]);
  });

  it('keeps a report whose session could not be verified, without an account', async () => {
    const { admin, deps } = dependencies({ getOptionalUserId: vi.fn(async () => null) });
    const response = await postMobileClientErrorsRouteResponse({ request: post(contract.request), dependencies: deps });
    expect(response.status).toBe(204);
    expect(admin.inserted[0].user_id).toBeNull();
  });

  it('refuses a broken or hostile sender before storing anything', async () => {
    const limited = dependencies({
      enforceBackendRateLimit: vi.fn(async () => {
        throw new BackendRateLimitError({ allowed: false, limit: 20, remaining: 0, retryAfterSeconds: 60, resetAt: '2026-11-27T10:10:00.000Z' });
      }),
    });
    expect((await postMobileClientErrorsRouteResponse({ request: post(contract.request), dependencies: limited.deps })).status).toBe(429);

    const wrongType = dependencies();
    const textRequest = new Request('http://localhost/api/mobile/client-errors', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    expect((await postMobileClientErrorsRouteResponse({ request: textRequest, dependencies: wrongType.deps })).status).toBe(415);

    const large = dependencies();
    const tooLarge = post({ ...contract.request, stack: 'x'.repeat(MAX_MOBILE_CLIENT_ERROR_BYTES) });
    expect((await postMobileClientErrorsRouteResponse({ request: tooLarge, dependencies: large.deps })).status).toBe(413);

    const invalid = dependencies();
    const response = await postMobileClientErrorsRouteResponse({ request: post(contract.errors.invalid.request), dependencies: invalid.deps });
    expect(response.status).toBe(contract.errors.invalid.status);
    await expect(response.json()).resolves.toEqual(contract.errors.invalid.response);

    for (const { admin } of [limited, wrongType, large, invalid]) expect(admin.inserted).toEqual([]);
  });

  it('answers 500 when the row cannot be stored', async () => {
    const admin = insertingClient({ error: { message: 'down' } });
    const { deps } = dependencies({ createServiceClient: () => admin.client });
    expect((await postMobileClientErrorsRouteResponse({ request: post(contract.request), dependencies: deps })).status).toBe(500);
  });
});

describe('parseMobileClientErrorReport', () => {
  const valid = contract.request;

  it('truncates again on the server: message 500, stack 4,000, component stack 2,000', () => {
    const parsed = parseMobileClientErrorReport({
      ...valid,
      message: 'm'.repeat(900),
      stack: 's'.repeat(9_000),
      componentStack: 'c'.repeat(3_000),
    });
    expect(parsed?.message).toHaveLength(500);
    expect(parsed?.stack).toHaveLength(4_000);
    expect(parsed?.componentStack).toHaveLength(2_000);
  });

  it('keeps a route\'s path alone, and drops one that is not a path', () => {
    expect(parseMobileClientErrorReport({ ...valid, route: '/search?q=private words#x' })?.route).toBe('/search');
    expect(parseMobileClientErrorReport({ ...valid, route: 'javascript:alert(1)' })?.route).toBeNull();
    expect(parseMobileClientErrorReport({ ...valid, route: null })?.route).toBeNull();
  });

  it('drops app fields that are not the app\'s shape, and refuses what it cannot store', () => {
    expect(parseMobileClientErrorReport({ ...valid, appVersion: 'not a version!', updateId: '<script>' }))
      .toMatchObject({ appVersion: null, updateId: null });
    for (const broken of [
      null,
      [],
      { ...valid, message: '' },
      { ...valid, message: 42 },
      { ...valid, platform: 'web' },
      { ...valid, fatal: 'yes' },
      { ...valid, stack: 12 },
    ]) {
      expect(parseMobileClientErrorReport(broken)).toBeNull();
    }
  });
});
