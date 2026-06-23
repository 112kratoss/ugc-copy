import { beforeEach, describe, expect, it, vi } from 'vitest';

const rateLimitRpcMock = vi.fn();
const upsertCalls: Array<{
  values: Record<string, unknown>;
  options: Record<string, unknown> | undefined;
}> = [];

function createPreferencesQuery(row: Record<string, unknown> | null) {
  const maybeSingle = vi.fn(async () => ({ data: row, error: null }));
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  return { select, eq, maybeSingle };
}

function createUserSupabaseMock(options: {
  authError?: Error | null;
  preferencesRow?: Record<string, unknown> | null;
} = {}) {
  const preferencesQuery = createPreferencesQuery(options.preferencesRow ?? null);

  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: options.authError ? null : { id: 'user-1' } },
        error: options.authError ?? null,
      })),
    },
    from(table: string) {
      if (table !== 'mobile_notification_preferences') {
        throw new Error(`Unexpected table ${table}`);
      }

      return {
        select: preferencesQuery.select,
        upsert(values: Record<string, unknown>, options?: Record<string, unknown>) {
          upsertCalls.push({ values, options });
          return {
            select(fields: string) {
              expect(fields).toBe('push_enabled, generation_enabled, commerce_enabled, social_enabled');
              return {
                async single() {
                  return {
                    data: {
                      push_enabled: values.push_enabled ?? true,
                      generation_enabled: values.generation_enabled ?? true,
                      commerce_enabled: values.commerce_enabled ?? true,
                      social_enabled: values.social_enabled ?? true,
                    },
                    error: null,
                  };
                },
              };
            },
          };
        },
      };
    },
  };
}

describe('mobile notification preferences service', () => {
  const getAdminSupabase = vi.fn(() => ({ rpc: rateLimitRpcMock }));

  beforeEach(() => {
    vi.resetModules();
    upsertCalls.length = 0;
    getAdminSupabase.mockClear();
    rateLimitRpcMock.mockReset();
    rateLimitRpcMock.mockResolvedValue({
      data: {
        allowed: true,
        limit: 30,
        remaining: 29,
        retryAfterSeconds: 0,
        resetAt: '2026-06-22T06:30:00.000Z',
      },
      error: null,
    });
  });

  it('returns unauthorized before preference work when the user session is missing', async () => {
    const { getMobileNotificationPreferencesForRoute } = await import('@/lib/mobile-notification-preferences-service');
    const result = await getMobileNotificationPreferencesForRoute({
      userSupabase: createUserSupabaseMock({ authError: new Error('missing session') }),
    });

    expect(result).toEqual({
      ok: false,
      body: { error: 'Unauthorized' },
      status: 401,
    });
    expect(getAdminSupabase).not.toHaveBeenCalled();
    expect(upsertCalls).toEqual([]);
  });

  it('loads existing preferences for authenticated mobile users', async () => {
    const { getMobileNotificationPreferencesForRoute } = await import('@/lib/mobile-notification-preferences-service');
    const result = await getMobileNotificationPreferencesForRoute({
      userSupabase: createUserSupabaseMock({
        preferencesRow: {
          push_enabled: false,
          generation_enabled: true,
          commerce_enabled: false,
          social_enabled: true,
        },
      }),
    });

    expect(result).toEqual({
      ok: true,
      body: {
        success: true,
        preferences: {
          pushEnabled: false,
          generationEnabled: true,
          commerceEnabled: false,
          socialEnabled: true,
        },
      },
    });
    expect(getAdminSupabase).not.toHaveBeenCalled();
    expect(upsertCalls).toEqual([]);
  });

  it('rate limits before upserting preference updates', async () => {
    const { updateMobileNotificationPreferencesForRoute } = await import('@/lib/mobile-notification-preferences-service');
    const result = await updateMobileNotificationPreferencesForRoute({
      getAdminSupabase,
      requestBody: { pushEnabled: false, socialEnabled: false },
      userSupabase: createUserSupabaseMock(),
    });

    expect(result).toEqual({
      ok: true,
      body: {
        success: true,
        preferences: {
          pushEnabled: false,
          generationEnabled: true,
          commerceEnabled: true,
          socialEnabled: false,
        },
      },
    });
    expect(rateLimitRpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'mobile-notification-preferences:update',
      p_subject_key: 'user-1',
      p_limit: 30,
      p_window_seconds: 600,
    });
    expect(upsertCalls).toEqual([
      {
        values: {
          user_id: 'user-1',
          push_enabled: false,
          social_enabled: false,
        },
        options: { onConflict: 'user_id' },
      },
    ]);
  });

  it('returns the backend rate-limit error before upserting when updates exceed the limit', async () => {
    rateLimitRpcMock.mockResolvedValueOnce({
      data: {
        allowed: false,
        limit: 30,
        remaining: 0,
        retryAfterSeconds: 45,
        resetAt: '2026-06-22T06:30:00.000Z',
      },
      error: null,
    });

    const { updateMobileNotificationPreferencesForRoute } = await import('@/lib/mobile-notification-preferences-service');
    const result = await updateMobileNotificationPreferencesForRoute({
      getAdminSupabase,
      requestBody: { pushEnabled: true },
      userSupabase: createUserSupabaseMock(),
    });

    expect(result).toMatchObject({
      ok: false,
      status: 429,
      rateLimitError: expect.any(Error),
    });
    expect(upsertCalls).toEqual([]);
  });
});
