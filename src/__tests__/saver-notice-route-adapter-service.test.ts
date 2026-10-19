import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import { postSaverNoticeRouteResponse } from '@/lib/saver-notice-route-adapter-service';

function userClient(user: { id: string; is_anonymous?: boolean } | null) {
  return () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user }, error: user ? null : new Error('no session') })) },
  }) as unknown as SupabaseClient;
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    createServiceClient: vi.fn(() => ({ kind: 'service' }) as unknown as SupabaseClient),
    createUserClient: userClient({ id: 'viewer-1' }),
    enforceBackendRateLimit: vi.fn(async () => ({
      allowed: true, limit: 20, remaining: 19, retryAfterSeconds: 0, resetAt: '2026-10-19T10:00:00.000Z',
    })),
    logError: vi.fn(),
    recordSaverNoticeSeen: vi.fn(async () => true),
    ...overrides,
  };
}

const request = () => new Request('http://localhost/api/profile/saver-notice', { method: 'POST' });

// The record is read with the profile both clients load (`saverNoticeSeen`);
// the route only writes it.
describe('saver notice route', () => {
  it('records the telling for the signed-in account, privately, within its rate limit', async () => {
    const deps = dependencies();
    const response = await postSaverNoticeRouteResponse({ request: request(), dependencies: deps });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({ seen: true });
    // Review 4 finding #16: the whole limit, window included, as the route passes it.
    expect(deps.enforceBackendRateLimit).toHaveBeenCalledWith({ kind: 'service' }, {
      scope: 'saver-notice:record',
      limit: 20,
      windowSeconds: 600,
      key: 'viewer-1',
    });
    expect(deps.recordSaverNoticeSeen).toHaveBeenCalledWith({ kind: 'service' }, 'viewer-1');
  });

  // Review 4 finding #20.
  it('answers 404, not "told", when the account has no profile to hold the record', async () => {
    const deps = dependencies({ recordSaverNoticeSeen: vi.fn(async () => false) });

    const response = await postSaverNoticeRouteResponse({ request: request(), dependencies: deps });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.not.toHaveProperty('seen');
  });

  it.each([
    { kind: 'no session', user: null },
    // A guest saves nothing, so it is told nothing.
    { kind: 'a guest', user: { id: 'guest-1', is_anonymous: true } },
  ])('refuses $kind without writing', async ({ user }) => {
    const deps = dependencies({ createUserClient: userClient(user) });

    const response = await postSaverNoticeRouteResponse({ request: request(), dependencies: deps });

    expect(response.status).toBe(401);
    expect(deps.recordSaverNoticeSeen).not.toHaveBeenCalled();
  });

  it('answers a record over its rate limit with 429, and records nothing', async () => {
    const deps = dependencies({
      enforceBackendRateLimit: vi.fn(async () => {
        throw new BackendRateLimitError({
          allowed: false, limit: 20, remaining: 0, retryAfterSeconds: 60, resetAt: '2026-10-19T10:10:00.000Z',
        });
      }),
    });

    const response = await postSaverNoticeRouteResponse({ request: request(), dependencies: deps });

    expect(response.status).toBe(429);
    expect(deps.recordSaverNoticeSeen).not.toHaveBeenCalled();
  });

  it('answers 500 when the record cannot be written, and logs it', async () => {
    const deps = dependencies({
      recordSaverNoticeSeen: vi.fn(async () => { throw new Error('timeout'); }),
    });

    expect((await postSaverNoticeRouteResponse({ request: request(), dependencies: deps })).status).toBe(500);
    expect(deps.logError).toHaveBeenCalledTimes(1);
  });
});
