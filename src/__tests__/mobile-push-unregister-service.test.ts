import { describe, expect, it, vi } from 'vitest';

import { AGENT_ACCESS_NOT_ENDED_CODE, unregisterMobilePushTokenForRoute } from '@/lib/mobile-push-unregister-service';

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
        ['is_active', true],
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
      ['is_active', true],
    ]);
  });

  it.each([
    ['a named token', { expoPushToken: 'ExponentPushToken[old123]' }],
    ['a device id', { deviceId: 'device-1' }],
  ])('retires only tokens that are still active when unregistering %s', async (_label, requestBody) => {
    // disabled_at records when a token stopped receiving pushes. A row the
    // receipts job, a newer token on the same device or an earlier sign-out
    // already retired must keep that time, not take this request's.
    const user = createUserClient();

    await unregisterMobilePushTokenForRoute({
      getAdminSupabase: () => createRateLimitClient(),
      requestBody,
      userSupabase: user.client,
    });

    expect(user.updateCalls).toHaveLength(1);
    expect(user.updateCalls[0]?.eqFilters).toContainEqual(['is_active', true]);
  });

  it('rejects empty unregister requests instead of disabling every device implicitly', async () => {
    const user = createUserClient();

    await expect(unregisterMobilePushTokenForRoute({
      getAdminSupabase: () => createRateLimitClient(),
      requestBody: {},
      userSupabase: user.client,
    })).resolves.toEqual({
      ok: false,
      body: { error: 'Provide an Expo push token or device ID.' },
      status: 400,
    });

    expect(user.updateCalls).toEqual([]);
  });

  it('refuses the all-device request installed apps still send from a phone that never registered', async () => {
    // Sign-out used to send this when the install had neither a token nor a
    // device id stored. That install has nothing of its own here, so the
    // request retired the token of every other device on the account.
    const user = createUserClient();
    const getAdminSupabase = vi.fn(() => createRateLimitClient());

    await expect(unregisterMobilePushTokenForRoute({
      getAdminSupabase,
      requestBody: { platform: 'android', allDevices: true },
      userSupabase: user.client,
    })).resolves.toEqual({
      ok: false,
      body: { error: 'Provide an Expo push token or device ID.' },
      status: 400,
    });

    expect(getAdminSupabase).not.toHaveBeenCalled();
    expect(user.updateCalls).toEqual([]);
  });

  it('never lets allDevices widen a request that names a device', async () => {
    const user = createUserClient();

    await unregisterMobilePushTokenForRoute({
      getAdminSupabase: () => createRateLimitClient(),
      requestBody: { deviceId: 'device-1', allDevices: true },
      userSupabase: user.client,
    });

    expect(user.updateCalls).toHaveLength(1);
    expect(user.updateCalls[0]?.eqFilters).toEqual([
      ['user_id', 'user-1'],
      ['device_id', 'device-1'],
      ['is_active', true],
    ]);
  });

  // Sign out of all devices (product decisions 2026-10-17, item 9) ends every
  // session of the account, and a phone whose session ended cannot retire its
  // own token afterwards: the app asks for the whole account first, by name.
  it('retires every live token of the account for a sign-out everywhere', async () => {
    const user = createUserClient();

    await expect(unregisterMobilePushTokenForRoute({
      getAdminSupabase: () => createRateLimitClient(),
      requestBody: { scope: 'account', expoPushToken: 'ExponentPushToken[this-phone]', platform: 'ios' },
      userSupabase: user.client,
    })).resolves.toEqual({ ok: true, body: { success: true } });

    expect(user.updateCalls).toHaveLength(1);
    expect(user.updateCalls[0]?.eqFilters).toEqual([
      ['user_id', 'user-1'],
      ['is_active', true],
    ]);
  });

  // That same request is how both clients say "Sign out everywhere" to this app, and the sign-out
  // itself ends sessions only. An app connected through the app's own authorization server is not
  // a session, so the account's are ended here (docs/plans/agent-token-broker-plan-2026-11-26.md).
  it('ends the account\'s connected apps with a sign-out everywhere, and with nothing less', async () => {
    const endAgentAccess = vi.fn(async () => 2);
    const everywhere = createUserClient();
    await expect(unregisterMobilePushTokenForRoute({
      endAgentAccess,
      getAdminSupabase: () => createRateLimitClient(),
      requestBody: { scope: 'account' },
      userSupabase: everywhere.client,
    })).resolves.toEqual({ ok: true, body: { success: true } });
    expect(endAgentAccess).toHaveBeenCalledTimes(1);
    expect(endAgentAccess).toHaveBeenCalledWith('user-1');

    // One phone's sign-out, or a token retired by name, ends no app.
    for (const requestBody of [
      { expoPushToken: 'ExponentPushToken[this-phone]' },
      { deviceId: 'device-1' },
      { scope: 'all', allDevices: true },
    ]) {
      await unregisterMobilePushTokenForRoute({
        endAgentAccess,
        getAdminSupabase: () => createRateLimitClient(),
        requestBody,
        userSupabase: createUserClient().client,
      });
    }
    expect(endAgentAccess).toHaveBeenCalledTimes(1);
  });

  it('ends no app for a caller it does not know', async () => {
    const endAgentAccess = vi.fn(async () => 0);
    await unregisterMobilePushTokenForRoute({
      endAgentAccess,
      getAdminSupabase: () => createRateLimitClient(),
      requestBody: { scope: 'account' },
      userSupabase: createUserClient({ authenticated: false }).client,
    });
    expect(endAgentAccess).not.toHaveBeenCalled();
  });

  // The limit is shared with every phone's ordinary sign-out. A person at it must still be able to
  // end their agents, so they are ended first, and the refusal that follows does not say otherwise.
  it('ends the apps before its rate limit, so an account at the limit still ends them', async () => {
    const endAgentAccess = vi.fn(async () => 1);
    const result = await unregisterMobilePushTokenForRoute({
      endAgentAccess,
      getAdminSupabase: () => createRateLimitClient(false),
      requestBody: { scope: 'account' },
      userSupabase: createUserClient().client,
    });
    expect(endAgentAccess).toHaveBeenCalledWith('user-1');
    expect(result).toMatchObject({ ok: false, status: 429 });
    expect((result as { body: Record<string, unknown> }).body.code).toBeUndefined();
    expect((result as { rateLimitError?: unknown }).rateLimitError).toBeDefined();
  });

  it('marks every refusal after a failed ending, so no answer reads as ended when it was not', async () => {
    const failing = () => vi.fn(async () => { throw new Error('db down'); });
    // The apps could not be ended, and the push tokens were retired: the test above this block's
    // sibling. Here: and then the limit refused, or the token update failed.
    const limited = await unregisterMobilePushTokenForRoute({
      endAgentAccess: failing(),
      getAdminSupabase: () => createRateLimitClient(false),
      requestBody: { scope: 'account' },
      userSupabase: createUserClient().client,
    });
    expect(limited).toMatchObject({ ok: false, status: 429, body: { code: 'AGENT_ACCESS_NOT_ENDED' } });
    // Answered from the body, which carries the mark; the limiter's own response would drop it.
    expect((limited as { rateLimitError?: unknown }).rateLimitError).toBeUndefined();

    const tokensFailed = await unregisterMobilePushTokenForRoute({
      endAgentAccess: failing(),
      getAdminSupabase: () => createRateLimitClient(),
      requestBody: { scope: 'account' },
      userSupabase: createUserClient({ updateError: new Error('update failed') }).client,
    });
    expect(tokensFailed).toMatchObject({ ok: false, status: 500, body: { error: 'Failed to unregister mobile push token.', code: 'AGENT_ACCESS_NOT_ENDED' } });
  });

  it('reads no other scope as the whole account', async () => {
    const user = createUserClient();

    await expect(unregisterMobilePushTokenForRoute({
      getAdminSupabase: () => createRateLimitClient(),
      requestBody: { scope: 'all', allDevices: true },
      userSupabase: user.client,
    })).resolves.toEqual({
      ok: false,
      body: { error: 'Provide an Expo push token or device ID.' },
      status: 400,
    });
    expect(user.updateCalls).toEqual([]);
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
      requestBody: { deviceId: 'device-1' },
      userSupabase: user.client,
    })).resolves.toEqual({
      ok: false,
      body: { error: 'Failed to unregister mobile push token.' },
      status: 500,
    });
  });
});
