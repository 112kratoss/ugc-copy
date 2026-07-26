import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MobileNotificationError,
  buildMobileNotificationDeepLink,
  createMobileNotification,
  hasPendingMobilePushReceipts,
  normalizeMobilePushTokenPayload,
  processPendingMobilePushReceipts,
  sendExpoPushNotification,
  sendExpoPushNotificationWithRetry,
} from '@/lib/mobile-notifications';
import { EXTERNAL_API_REQUEST_TIMEOUT_MS } from '@/lib/provider-fetch';

function createPendingReceiptQuery(deliveryRows: Record<string, unknown>[]) {
  const limit = vi.fn(async () => ({ data: deliveryRows, error: null }));
  const order = vi.fn(() => ({ limit }));
  const lte = vi.fn(() => ({ order }));
  const eq = vi.fn(() => ({ lte }));

  return { eq, lte, order, limit };
}

describe('mobile notifications', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('normalizes Expo push token registration payloads', () => {
    expect(normalizeMobilePushTokenPayload({
      expoPushToken: ' ExponentPushToken[abc123] ',
      platform: 'ios',
      deviceId: 'device-1',
      appVersion: '1.0.0',
    })).toEqual({
      expoPushToken: 'ExponentPushToken[abc123]',
      platform: 'ios',
      deviceId: 'device-1',
      appVersion: '1.0.0',
    });
  });

  it('rejects invalid Expo push token registration payloads', () => {
    expect(() => normalizeMobilePushTokenPayload({
      expoPushToken: 'not-a-token',
      platform: 'web',
    })).toThrow(MobileNotificationError);
  });

  it('sends push payloads through the Expo push API', async () => {
    const timeoutSignal = AbortSignal.abort();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutSignal);
    const fetcher = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({
        data: {
          status: 'ok',
          id: 'ticket-1',
        },
      }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      })
    );

    await expect(sendExpoPushNotification({
      expoPushToken: 'ExponentPushToken[abc123]',
      title: 'Render ready',
      body: 'Your image finished.',
      data: {
        deepLink: '/viewer?source=studio-creations&initialId=gen-1',
        notificationId: 'notification-1',
        type: 'generation_succeeded',
        category: 'generation',
      },
      fetcher,
    })).resolves.toEqual({
      status: 'ok',
      id: 'ticket-1',
    });

    expect(fetcher).toHaveBeenCalledWith('https://exp.host/--/api/v2/push/send', expect.objectContaining({
      method: 'POST',
      signal: timeoutSignal,
    }));
    expect(timeoutSpy).toHaveBeenCalledWith(EXTERNAL_API_REQUEST_TIMEOUT_MS);
    const body = JSON.parse(String((fetcher.mock.calls[0]?.[1] as RequestInit).body));
    expect(body).toMatchObject({
      to: 'ExponentPushToken[abc123]',
      title: 'Render ready',
      body: 'Your image finished.',
      channelId: 'default',
      priority: 'high',
      data: {
        notificationId: 'notification-1',
        type: 'generation_succeeded',
        category: 'generation',
      },
    });
  });

  it('retries transient Expo send failures and reports the provider attempt count', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        errors: [{ message: 'Expo temporarily unavailable' }],
      }), {
        headers: { 'content-type': 'application/json' },
        status: 500,
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          status: 'ok',
          id: 'ticket-2',
        },
      }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      }));

    await expect(sendExpoPushNotificationWithRetry({
      expoPushToken: 'ExponentPushToken[abc123]',
      title: 'Render ready',
      body: 'Your image finished.',
      data: {
        deepLink: '/viewer?source=studio-creations&initialId=gen-1',
        notificationId: 'notification-1',
        type: 'generation_succeeded',
        category: 'generation',
      },
      fetcher: fetcher as unknown as typeof fetch,
      retryDelayMs: () => 0,
    })).resolves.toEqual({
      result: {
        status: 'ok',
        id: 'ticket-2',
      },
      attemptCount: 2,
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('builds mobile deep links for notification targets', () => {
    expect(buildMobileNotificationDeepLink({ kind: 'generation', generationId: 'gen-1' }))
      .toBe('/viewer?source=studio-creations&initialId=gen-1');
    expect(buildMobileNotificationDeepLink({ kind: 'showcasePost', postId: 'post-1' }))
      .toBe('/viewer?source=showcase-feed&initialId=post-1');
    expect(buildMobileNotificationDeepLink({ kind: 'notifications' }))
      .toBe('/studio');
  });

  it('checks only receipts that have reached the recommended 15-minute age', async () => {
    const limit = vi.fn(async () => ({
      data: [{ id: 'delivery-1' }],
      error: null,
    }));
    const lte = vi.fn(() => ({ limit }));
    const eq = vi.fn(() => ({ lte }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));
    const adminSupabase = { from };

    await expect(hasPendingMobilePushReceipts(adminSupabase as never, {
      now: new Date('2026-05-26T12:00:00.000Z'),
    })).resolves.toBe(true);

    expect(from).toHaveBeenCalledWith('mobile_push_deliveries');
    expect(select).toHaveBeenCalledWith('id');
    expect(eq).toHaveBeenCalledWith('receipt_status', 'pending');
    expect(lte).toHaveBeenCalledWith('sent_at', '2026-05-26T11:45:00.000Z');
    expect(limit).toHaveBeenCalledWith(1);
  });

  it('processes Expo receipts and disables unregistered push tokens', async () => {
    const timeoutSignal = AbortSignal.abort();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutSignal);
    const deliveryRows = [
      {
        id: 'delivery-1',
        token_id: 'token-1',
        push_ticket_id: 'ticket-1',
        receipt_status: 'pending',
        sent_at: '2026-05-26T00:00:00.000Z',
      },
    ];
    const deliveryUpdates: Array<{ id: string; values: Record<string, unknown> }> = [];
    const tokenUpdates: Array<{ id: string; values: Record<string, unknown> }> = [];
    const pendingQuery = createPendingReceiptQuery(deliveryRows);

    const adminSupabase = {
      from(table: string) {
        if (table === 'mobile_push_deliveries') {
          return {
            select() {
              return { eq: pendingQuery.eq };
            },
            update(values: Record<string, unknown>) {
              return {
                eq(column: string, value: unknown) {
                  expect(column).toBe('id');
                  deliveryUpdates.push({ id: String(value), values });
                  return Promise.resolve({ error: null });
                },
              };
            },
          };
        }

        if (table === 'mobile_push_tokens') {
          return {
            update(values: Record<string, unknown>) {
              return {
                eq(column: string, value: unknown) {
                  expect(column).toBe('id');
                  tokenUpdates.push({ id: String(value), values });
                  return Promise.resolve({ error: null });
                },
              };
            },
          };
        }

        throw new Error(`Unexpected table ${table}`);
      },
    };

    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({
        data: {
          'ticket-1': {
            status: 'error',
            message: 'Device is no longer registered',
            details: {
              error: 'DeviceNotRegistered',
            },
          },
        },
      }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      })
    );

    await expect(processPendingMobilePushReceipts(
      adminSupabase as never,
      {
        fetcher: fetcher as unknown as typeof fetch,
        now: new Date('2026-05-26T12:00:00.000Z'),
      }
    )).resolves.toMatchObject({
      checkedCount: 1,
      staleCount: 0,
      updatedCount: 1,
      disabledTokenCount: 1,
    });

    expect(fetcher).toHaveBeenCalledWith('https://exp.host/--/api/v2/push/getReceipts', expect.objectContaining({
      method: 'POST',
      signal: timeoutSignal,
    }));
    expect(timeoutSpy).toHaveBeenCalledWith(EXTERNAL_API_REQUEST_TIMEOUT_MS);
    expect(pendingQuery.lte).toHaveBeenCalledWith('sent_at', '2026-05-26T11:45:00.000Z');
    expect(pendingQuery.order).toHaveBeenCalledWith('sent_at', { ascending: true });
    expect(pendingQuery.limit).toHaveBeenCalledWith(1000);
    expect(deliveryUpdates).toEqual([
      expect.objectContaining({
        id: 'delivery-1',
        values: expect.objectContaining({
          receipt_status: 'error',
          receipt_error_code: 'DeviceNotRegistered',
          receipt_message: 'Device is no longer registered',
        }),
      }),
    ]);
    expect(tokenUpdates).toEqual([
      expect.objectContaining({
        id: 'token-1',
        values: expect.objectContaining({
          is_active: false,
        }),
      }),
    ]);
  });

  it('records delivery errors when the Expo send call throws before a receipt is created', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));

    const deliveryInserts: Array<Record<string, unknown>> = [];
    const notificationUpdates: Array<{ id: string; values: Record<string, unknown> }> = [];

    const adminSupabase = {
      from(table: string) {
        if (table === 'mobile_notifications') {
          return {
            insert(values: Record<string, unknown>) {
              return {
                select() {
                  return {
                    async single() {
                      return {
                        data: {
                          id: 'notification-1',
                          user_id: 'user-1',
                          actor_user_id: null,
                          type: values.type,
                          category: values.category,
                          title: values.title,
                          body: values.body,
                          deep_link: values.deep_link,
                          object_type: values.object_type,
                          object_id: values.object_id,
                          event_count: 1,
                          is_read: false,
                          created_at: '2026-05-26T10:00:00.000Z',
                          updated_at: '2026-05-26T10:00:00.000Z',
                        },
                        error: null,
                      };
                    },
                  };
                },
              };
            },
            update(values: Record<string, unknown>) {
              return {
                eq(column: string, value: unknown) {
                  expect(column).toBe('id');
                  notificationUpdates.push({ id: String(value), values });
                  return Promise.resolve({ error: null });
                },
              };
            },
          };
        }

        if (table === 'mobile_notification_preferences') {
          return {
            select() {
              return {
                eq(column: string, value: unknown) {
                  expect(column).toBe('user_id');
                  expect(value).toBe('user-1');
                  return {
                    maybeSingle() {
                      return Promise.resolve({
                        data: {
                          push_enabled: true,
                          generation_enabled: true,
                          commerce_enabled: true,
                          social_enabled: true,
                        },
                        error: null,
                      });
                    },
                  };
                },
              };
            },
          };
        }

        if (table === 'mobile_push_tokens') {
          return {
            select() {
              const filters: Record<string, unknown> = {};
              const query = {
                error: null,
                data: [
                  {
                    id: 'token-1',
                    expo_push_token: 'ExponentPushToken[token123]',
                    platform: 'ios',
                  },
                ],
                eq(column: string, value: unknown) {
                  filters[column] = value;
                  return query;
                },
              };
              return query;
            },
          };
        }

        if (table === 'mobile_push_deliveries') {
          return {
            async insert(values: Record<string, unknown>) {
              deliveryInserts.push(values);
              return { error: null };
            },
          };
        }

        throw new Error(`Unexpected table ${table}`);
      },
    };

    await expect(createMobileNotification({
      adminSupabase: adminSupabase as never,
      userId: 'user-1',
      type: 'generation_succeeded',
      category: 'generation',
      title: 'Render ready',
      body: 'Open it in the app.',
      deepLink: '/viewer?source=studio-creations&initialId=gen-1',
      objectType: 'generation',
      objectId: 'gen-1',
    })).resolves.toMatchObject({
      id: 'notification-1',
      title: 'Render ready',
    });

    expect(deliveryInserts).toEqual([
      expect.objectContaining({
        notification_id: 'notification-1',
        user_id: 'user-1',
        token_id: 'token-1',
        expo_push_token: 'ExponentPushToken[token123]',
        platform: 'ios',
        send_status: 'error',
        receipt_status: 'error',
        receipt_message: 'Push send failed before a receipt was created.',
        provider_message: 'network down',
        provider_details: expect.objectContaining({
          attempts: 3,
          cause: {
            name: 'Error',
            message: 'network down',
          },
        }),
        attempt_count: 3,
      }),
    ]);
    expect(notificationUpdates).toEqual([
      expect.objectContaining({
        id: 'notification-1',
        values: expect.objectContaining({
          push_ticket_id: null,
          push_error: 'network down',
          pushed_at: expect.any(String),
        }),
      }),
    ]);
  });

  it('uses the atomic notification RPC for aggregated social events without re-pushing updated groups', async () => {
    const rpc = vi.fn(async (name: string, payload: Record<string, unknown>) => {
      expect(name).toBe('upsert_mobile_notification');
      expect(payload).toMatchObject({
        p_user_id: 'user-1',
        p_actor_user_id: 'actor-1',
        p_type: 'post_shared',
        p_category: 'social',
        p_aggregation_key: 'post-social:post_shared:user-1:post-1:123',
      });

      return {
        data: {
          notification: {
            id: 'notification-1',
            user_id: 'user-1',
            actor_user_id: 'actor-1',
            type: 'post_shared',
            category: 'social',
            title: 'Someone shared your post',
            body: 'Creator activity is grouped here to keep your phone quiet.',
            deep_link: '/viewer?source=showcase-feed&initialId=post-1',
            object_type: 'post',
            object_id: 'post-1',
            event_count: 2,
            is_read: false,
            created_at: '2026-05-26T10:00:00.000Z',
            updated_at: '2026-05-26T10:05:00.000Z',
          },
          wasCreated: false,
        },
        error: null,
      };
    });
    const from = vi.fn(() => {
      throw new Error('Aggregated updates should not load push tokens or preferences');
    });

    await expect(createMobileNotification({
      adminSupabase: { rpc, from } as never,
      userId: 'user-1',
      actorUserId: 'actor-1',
      type: 'post_shared',
      category: 'social',
      title: 'Someone shared your post',
      body: 'Creator activity is grouped here to keep your phone quiet.',
      deepLink: '/viewer?source=showcase-feed&initialId=post-1',
      objectType: 'post',
      objectId: 'post-1',
      aggregationKey: 'post-social:post_shared:user-1:post-1:123',
    })).resolves.toMatchObject({
      id: 'notification-1',
      eventCount: 2,
    });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(from).not.toHaveBeenCalled();
  });

  it('marks receipts stale once Expo clears them after 24 hours', async () => {
    const deliveryRows = [
      {
        id: 'delivery-1',
        token_id: 'token-1',
        push_ticket_id: 'ticket-1',
        receipt_status: 'pending',
        sent_at: '2026-05-25T07:00:00.000Z',
      },
    ];
    const deliveryUpdates: Array<{ id: string; values: Record<string, unknown> }> = [];
    const pendingQuery = createPendingReceiptQuery(deliveryRows);

    const adminSupabase = {
      from(table: string) {
        if (table === 'mobile_push_deliveries') {
          return {
            select() {
              return { eq: pendingQuery.eq };
            },
            update(values: Record<string, unknown>) {
              return {
                eq(column: string, value: unknown) {
                  expect(column).toBe('id');
                  deliveryUpdates.push({ id: String(value), values });
                  return Promise.resolve({ error: null });
                },
              };
            },
          };
        }

        if (table === 'mobile_push_tokens') {
          return {
            update() {
              throw new Error('Unexpected token deactivation');
            },
          };
        }

        throw new Error(`Unexpected table ${table}`);
      },
    };

    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ data: {} }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      })
    );

    await expect(processPendingMobilePushReceipts(
      adminSupabase as never,
      {
        fetcher: fetcher as unknown as typeof fetch,
        now: new Date('2026-05-26T12:00:00.000Z'),
      }
    )).resolves.toMatchObject({
      checkedCount: 1,
      updatedCount: 0,
      staleCount: 1,
      disabledTokenCount: 0,
    });

    expect(fetcher).not.toHaveBeenCalled();
    expect(deliveryUpdates).toEqual([
      expect.objectContaining({
        id: 'delivery-1',
        values: expect.objectContaining({
          receipt_status: 'stale',
          receipt_message: 'Receipt unavailable after 24 hours.',
        }),
      }),
    ]);
  });
});
