import { describe, expect, it, vi } from 'vitest';

import { unregisterMobilePushTokenForRoute } from '@/lib/mobile-push-unregister-service';

function createRateLimitClient(allowed = true) {
  return {
    rpc: vi.fn(async () => ({
      data: {
        allowed,
        limit: 20,
        remaining: allowed ? 19 : 0,
        retryAfterSeconds: allowed ? 0 : 25,
        resetAt: '2026-06-22T06:30:00.000Z',
      },
      error: null,
    })),
  };
}

function createUserClient({ authenticated = true, updateError = null }: {
  authenticated?: boolean;
  updateError?: Error | null;
} = {}) {
  const updateCalls: Array<{
    values: Record<string, unknown>;
    eqFilters: Array<[string, unknown]>;
  }> = [];

  return {
    updateCalls,
    client: {
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: authenticated ? { id: 'user-1' } : null },
          error: authenticated ? null : new Error('missing session'),
        })),
      },
      from(table: string) {
        expect(table).toBe('mobile_push_tokens');
        return {
          update(values: Record<string, unknown>) {
            const call = {
              values,
              eqFilters: [] as Array<[string, unknown]>,
              error: updateError,
              eq(column: string, value: unknown) {
                call.eqFilters.push([column, value]);
                return call;
              },
            };
            updateCalls.push(call);
            return call;
          },
        };
      },
    },
  };
}

describe('mobile push token unregister service', () => {
  it('rejects unauthenticated requests before parsing or privileged work', async () => {
    const user = createUserClient({ authenticated: false });
    const readRequestBody = vi.fn();
    const getAdminSupabase = vi.fn();

    await expect(unregisterMobilePushTokenForRoute({
      getAdminSupabase,
      readRequestBody,
      userSupabase: user.client,
    })).resolves.toEqual({
      ok: false,
      body: { error: 'Unauthorized' },
      status: 401,
    });

    expect(readRequestBody).not.toHaveBeenCalled();
    expect(getAdminSupabase).not.toHaveBeenCalled();
  });

  it('rate limits before deactivating a named Expo push token', async () => {
    const user = createUserClient();
    const adminSupabase = createRateLimitClient();

    await expect(unregisterMobilePushTokenForRoute({
      getAdminSupabase: () => adminSupabase,
      now: () => new Date('2026-05-26T08:00:00.000Z'),
      requestBody: { token: ' ExponentPushToken[old123] ', deviceId: 'device-ignored' },
      userSupabase: user.client,
    })).resolves.toEqual({ ok: true, body: { success: true } });

    expect(adminSupabase.rpc).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'mobile-push-token:unregister',
      p_subject_key: 'user-1',
      p_limit: 20,
      p_window_seconds: 600,
    });
    expect(user.updateCalls[0]).toMatchObject({
      values: {
        is_active: false,
        disabled_at: '2026-05-26T08:00:00.000Z',
      },
      eqFilters: [
        ['user_id', 'user-1'],
        ['expo_push_token', 'ExponentPushToken[old123]'],
      ],
    });
  });

  it('uses the device id when no token is supplied', async () => {
    const user = createUserClient();

    await unregisterMobilePushTokenForRoute({
      getAdminSupabase: () => createRateLimitClient(),
      requestBody: { deviceId: ' device-1 ' },
      userSupabase: user.client,
    });

    expect(user.updateCalls[0]?.eqFilters).toEqual([
      ['user_id', 'user-1'],
      ['device_id', 'device-1'],
    ]);
  });

  it('rejects empty unregister requests instead of disabling every device implicitly', async () => {
    const user = createUserClient();

    await expect(unregisterMobilePushTokenForRoute({
      getAdminSupabase: () => createRateLimitClient(),
      requestBody: {},
      userSupabase: user.client,
    })).resolves.toEqual({
      ok: false,
      body: { error: 'Provide an Expo push token, device ID, or allDevices: true.' },
      status: 400,
    });

    expect(user.updateCalls).toEqual([]);
  });

  it('allows explicit all-device unregister requests', async () => {
    const user = createUserClient();

    await expect(unregisterMobilePushTokenForRoute({
      getAdminSupabase: () => createRateLimitClient(),
      now: () => new Date('2026-05-26T08:00:00.000Z'),
      requestBody: { allDevices: true },
      userSupabase: user.client,
    })).resolves.toEqual({ ok: true, body: { success: true } });

    expect(user.updateCalls[0]).toMatchObject({
      values: {
        is_active: false,
        disabled_at: '2026-05-26T08:00:00.000Z',
      },
      eqFilters: [
        ['user_id', 'user-1'],
      ],
    });
  });

  it('returns a rate-limit error before token updates', async () => {
    const user = createUserClient();
    const result = await unregisterMobilePushTokenForRoute({
      getAdminSupabase: () => createRateLimitClient(false),
      requestBody: { deviceId: 'device-1' },
      userSupabase: user.client,
    });

    expect(result).toMatchObject({ ok: false, status: 429 });
    expect(result).toHaveProperty('rateLimitError');
    expect(user.updateCalls).toEqual([]);
  });

  it('maps token update failures to the stable API error', async () => {
    const user = createUserClient({ updateError: new Error('write failed') });

    await expect(unregisterMobilePushTokenForRoute({
      getAdminSupabase: () => createRateLimitClient(),
      requestBody: { allDevices: true },
      userSupabase: user.client,
    })).resolves.toEqual({
      ok: false,
      body: { error: 'Failed to unregister mobile push token.' },
      status: 500,
    });
  });
});
