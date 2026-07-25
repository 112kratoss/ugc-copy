import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

const ensureMobileNotificationPreferencesMock = vi.fn();

vi.mock('@/lib/mobile-notifications', async () => {
  const actual = await vi.importActual<typeof import('@/lib/mobile-notifications')>('@/lib/mobile-notifications');
  return {
    ...actual,
    ensureMobileNotificationPreferences: (...args: unknown[]) => ensureMobileNotificationPreferencesMock(...args),
  };
});

const upsertCalls: Array<{ values: Record<string, unknown>; options: Record<string, unknown> | undefined }> = [];
const deactivateCalls: Array<{
  values: Record<string, unknown>;
  eqFilters: Array<[string, unknown]>;
  neqFilters: Array<[string, unknown]>;
}> = [];
const crossUserDeactivateCalls: Array<{
  values: Record<string, unknown>;
  eqFilters: Array<[string, unknown]>;
  neqFilters: Array<[string, unknown]>;
}> = [];

function createRateLimitRpc({
  allowed = true,
  limit = 20,
  remaining = 19,
  retryAfterSeconds = 0,
  resetAt = '2026-06-22T06:30:00.000Z',
} = {}) {
  return vi.fn(async () => ({
    data: {
      allowed,
      limit,
      remaining,
      retryAfterSeconds,
      resetAt,
    },
    error: null,
  }));
}

function createUserSupabaseMock(options: { userId?: string | null; authError?: Error | null } = {}) {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: options.userId === null || options.authError ? null : { id: options.userId ?? 'user-1' } },
        error: options.authError ?? null,
      })),
    },
    from(table: string) {
      if (table !== 'mobile_push_tokens') {
        throw new Error(`Unexpected table ${table}`);
      }

      return {
        async upsert(values: Record<string, unknown>, options?: Record<string, unknown>) {
          upsertCalls.push({ values, options });
          return { error: null };
        },
        update(values: Record<string, unknown>) {
          const call = {
            values,
            eqFilters: [] as Array<[string, unknown]>,
            neqFilters: [] as Array<[string, unknown]>,
            error: null as null,
            eq(column: string, value: unknown) {
              call.eqFilters.push([column, value]);
              return call;
            },
            neq(column: string, value: unknown) {
              call.neqFilters.push([column, value]);
              return call;
            },
          };

          deactivateCalls.push(call);
          return call;
        },
      };
    },
  };
}

function createAdminSupabaseMock(rateLimitRpc: ReturnType<typeof createRateLimitRpc>) {
  return {
    rpc: rateLimitRpc,
    from(table: string) {
      if (table !== 'mobile_push_tokens') {
        throw new Error(`Unexpected admin table ${table}`);
      }

      return {
        update(values: Record<string, unknown>) {
          const call = {
            values,
            eqFilters: [] as Array<[string, unknown]>,
            neqFilters: [] as Array<[string, unknown]>,
            error: null as null,
            eq(column: string, value: unknown) {
              call.eqFilters.push([column, value]);
              return call;
            },
            neq(column: string, value: unknown) {
              call.neqFilters.push([column, value]);
              return call;
            },
          };

          crossUserDeactivateCalls.push(call);
          return call;
        },
      };
    },
  };
}

describe('mobile push registration service', () => {
  let rateLimitRpc: ReturnType<typeof createRateLimitRpc>;
  let getAdminSupabase: Mock<() => unknown>;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-26T08:00:00.000Z'));
    upsertCalls.length = 0;
    deactivateCalls.length = 0;
    crossUserDeactivateCalls.length = 0;
    rateLimitRpc = createRateLimitRpc();
    getAdminSupabase = vi.fn(() => createAdminSupabaseMock(rateLimitRpc));
    ensureMobileNotificationPreferencesMock.mockReset();
    ensureMobileNotificationPreferencesMock.mockResolvedValue({
      pushEnabled: true,
      generationEnabled: true,
      commerceEnabled: true,
      socialEnabled: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns unauthorized before parsing or privileged work when the mobile session is missing', async () => {
    const { registerMobilePushTokenForRoute } = await import('@/lib/mobile-push-registration-service');
    const result = await registerMobilePushTokenForRoute({
      getAdminSupabase,
      requestBody: {
        expoPushToken: 'ExponentPushToken[new123]',
        platform: 'android',
      },
      userSupabase: createUserSupabaseMock({ userId: null }),
    });

    expect(result).toEqual({
      ok: false,
      body: { error: 'Unauthorized' },
      status: 401,
    });
    expect(getAdminSupabase).not.toHaveBeenCalled();
    expect(upsertCalls).toEqual([]);
    expect(ensureMobileNotificationPreferencesMock).not.toHaveBeenCalled();
  });

  it('registers the latest token, deactivates stale device tokens, and initializes preferences', async () => {
    const { registerMobilePushTokenForRoute } = await import('@/lib/mobile-push-registration-service');
    const userSupabase = createUserSupabaseMock();
    const result = await registerMobilePushTokenForRoute({
      getAdminSupabase,
      requestBody: {
        expoPushToken: 'ExponentPushToken[new123]',
        platform: 'android',
        deviceId: 'device-1',
        appVersion: '1.0.0',
      },
      userSupabase,
    });

    expect(result).toEqual({
      ok: true,
      body: { success: true },
    });
    expect(rateLimitRpc).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'mobile-push-token:register',
      p_subject_key: 'user-1',
      p_limit: 20,
      p_window_seconds: 600,
    });
    expect(upsertCalls).toEqual([
      {
        values: {
          user_id: 'user-1',
          expo_push_token: 'ExponentPushToken[new123]',
          platform: 'android',
          device_id: 'device-1',
          app_version: '1.0.0',
          is_active: true,
          disabled_at: null,
          last_seen_at: '2026-05-26T08:00:00.000Z',
        },
        options: { onConflict: 'user_id,expo_push_token' },
      },
    ]);
    expect(deactivateCalls).toEqual([
      {
        values: {
          is_active: false,
          disabled_at: '2026-05-26T08:00:00.000Z',
        },
        eqFilters: [
          ['user_id', 'user-1'],
          ['device_id', 'device-1'],
          ['is_active', true],
        ],
        neqFilters: [
          ['expo_push_token', 'ExponentPushToken[new123]'],
        ],
        error: null,
        eq: expect.any(Function),
        neq: expect.any(Function),
      },
    ]);
    expect(crossUserDeactivateCalls).toEqual([
      {
        values: {
          is_active: false,
          disabled_at: '2026-05-26T08:00:00.000Z',
        },
        eqFilters: [
          ['expo_push_token', 'ExponentPushToken[new123]'],
          ['is_active', true],
        ],
        neqFilters: [
          ['user_id', 'user-1'],
        ],
        error: null,
        eq: expect.any(Function),
        neq: expect.any(Function),
      },
    ]);
    expect(ensureMobileNotificationPreferencesMock).toHaveBeenCalledWith(userSupabase, 'user-1');
  });

  it('returns the backend rate-limit response before token or preference writes', async () => {
    rateLimitRpc = createRateLimitRpc({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 35,
    });
    getAdminSupabase = vi.fn(() => createAdminSupabaseMock(rateLimitRpc));

    const { registerMobilePushTokenForRoute } = await import('@/lib/mobile-push-registration-service');
    const result = await registerMobilePushTokenForRoute({
      getAdminSupabase,
      requestBody: {
        expoPushToken: 'ExponentPushToken[new123]',
        platform: 'android',
        deviceId: 'device-1',
      },
      userSupabase: createUserSupabaseMock(),
    });

    expect(result).toMatchObject({
      ok: false,
      status: 429,
      rateLimitError: expect.any(Error),
    });
    expect(upsertCalls).toEqual([]);
    expect(deactivateCalls).toEqual([]);
    expect(ensureMobileNotificationPreferencesMock).not.toHaveBeenCalled();
  });
});
