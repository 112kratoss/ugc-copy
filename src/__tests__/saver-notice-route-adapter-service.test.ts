import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import {
  getSaverNoticeRouteResponse,
  postSaverNoticeRouteResponse,
} from '@/lib/saver-notice-route-adapter-service';

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
    readSaverNoticeSeen: vi.fn(async () => true),
    recordSaverNoticeSeen: vi.fn(async () => undefined),
    ...overrides,
  };
}

const request = (method: string) => new Request('http://localhost/api/profile/saver-notice', { method });

describe('saver notice route', () => {
  it("answers whether the signed-in account has been told, privately", async () => {
    const deps = dependencies();
    const response = await getSaverNoticeRouteResponse({ request: request('GET'), dependencies: deps });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({ seen: true });
    expect(deps.readSaverNoticeSeen).toHaveBeenCalledWith({ kind: 'service' }, 'viewer-1');
  });

  it('records the telling for the signed-in account, within its rate limit', async () => {
    const deps = dependencies();
    const response = await postSaverNoticeRouteResponse({ request: request('POST'), dependencies: deps });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ seen: true });
    expect(deps.enforceBackendRateLimit).toHaveBeenCalledWith({ kind: 'service' }, expect.objectContaining({
      scope: 'saver-notice:record',
      key: 'viewer-1',
    }));
    expect(deps.recordSaverNoticeSeen).toHaveBeenCalledWith({ kind: 'service' }, 'viewer-1');
  });

  it.each([
    { kind: 'no session', user: null },
    // A guest saves nothing, so it is told nothing.
    { kind: 'a guest', user: { id: 'guest-1', is_anonymous: true } },
  ])('refuses $kind without reading or writing', async ({ user }) => {
    const deps = dependencies({ createUserClient: userClient(user) });

    for (const call of [getSaverNoticeRouteResponse, postSaverNoticeRouteResponse]) {
      const response = await call({ request: request(call === getSaverNoticeRouteResponse ? 'GET' : 'POST'), dependencies: deps });
      expect(response.status).toBe(401);
    }
    expect(deps.readSaverNoticeSeen).not.toHaveBeenCalled();
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

    const response = await postSaverNoticeRouteResponse({ request: request('POST'), dependencies: deps });

    expect(response.status).toBe(429);
    expect(deps.recordSaverNoticeSeen).not.toHaveBeenCalled();
  });

  it('answers 500 when the record cannot be read or written, and logs it', async () => {
    const deps = dependencies({
      readSaverNoticeSeen: vi.fn(async () => { throw new Error('timeout'); }),
      recordSaverNoticeSeen: vi.fn(async () => { throw new Error('timeout'); }),
    });

    expect((await getSaverNoticeRouteResponse({ request: request('GET'), dependencies: deps })).status).toBe(500);
    expect((await postSaverNoticeRouteResponse({ request: request('POST'), dependencies: deps })).status).toBe(500);
    expect(deps.logError).toHaveBeenCalledTimes(2);
  });
});
