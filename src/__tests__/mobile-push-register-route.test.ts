import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createUserClientMock = vi.fn();
const ensureMobileNotificationPreferencesMock = vi.fn();
const upsertCalls: Array<{ values: Record<string, unknown>; options: Record<string, unknown> | undefined }> = [];
const deactivateCalls: Array<{
  values: Record<string, unknown>;
  eqFilters: Array<[string, unknown]>;
  neqFilters: Array<[string, unknown]>;
}> = [];

vi.mock('@/lib/server-helpers', () => ({
  createUserClient: (request: Request) => createUserClientMock(request),
}));

vi.mock('@/lib/mobile-notifications', async () => {
  const actual = await vi.importActual<typeof import('@/lib/mobile-notifications')>('@/lib/mobile-notifications');
  return {
    ...actual,
    ensureMobileNotificationPreferences: (...args: unknown[]) => ensureMobileNotificationPreferencesMock(...args),
  };
});

function createUserSupabaseMock() {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: 'user-1' } },
        error: null,
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

describe('/api/mobile/notifications/register route', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-26T08:00:00.000Z'));
    upsertCalls.length = 0;
    deactivateCalls.length = 0;
    createUserClientMock.mockReset();
    ensureMobileNotificationPreferencesMock.mockReset();
    createUserClientMock.mockReturnValue(createUserSupabaseMock());
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

  it('deactivates older active tokens for the same device after registering the latest token', async () => {
    const { POST } = await import('@/app/api/mobile/notifications/register/route');
    const response = await POST(
      new Request('http://localhost/api/mobile/notifications/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expoPushToken: 'ExponentPushToken[new123]',
          platform: 'android',
          deviceId: 'device-1',
          appVersion: '1.0.0',
        }),
      }) as never
    );

    await expect(response.json()).resolves.toEqual({ success: true });
    expect(response.status).toBe(200);
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
    expect(ensureMobileNotificationPreferencesMock).toHaveBeenCalledTimes(1);
  });
});
