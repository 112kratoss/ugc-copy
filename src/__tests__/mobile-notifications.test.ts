import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MobileNotificationError,
  buildMobileNotificationDeepLink,
  createMobileNotification,
  hasPendingMobilePushReceipts,
  normalizeMobilePushTokenPayload,
  processMobilePushMaintenance,
  processPendingMobilePushReceipts,
  sendExpoPushNotification,
  sendExpoPushNotificationBatch,
  sendExpoPushNotificationWithRetry,
  toMobileNotificationRecord,
} from '@/lib/mobile-notifications';
import { EXTERNAL_API_REQUEST_TIMEOUT_MS } from '@/lib/provider-fetch';

function createPendingReceiptQuery(deliveryRows: Record<string, unknown>[]) {
  const limit = vi.fn(async () => ({ data: deliveryRows, error: null }));
  const order = vi.fn(() => ({ limit }));
  const lte = vi.fn(() => ({ order }));
  const eq = vi.fn(() => ({ lte }));

  return { eq, lte, order, limit };
}

type PushTokenRow = { id: string; expo_push_token: string; platform: 'ios' | 'android' };
type PushTokenState = { id: string; is_active: boolean; disabled_at: string | null };

/**
 * `mobile_push_tokens` as the three retirement paths see it. An update changes
 * only the rows its filters match and, when asked to, hands those rows back, so
 * a test can read what became of a row as well as which filters were sent.
 */
function createPushTokenTable(rows: PushTokenState[]) {
  const updates: Array<{ values: Record<string, unknown>; filters: Array<[string, unknown]> }> = [];

  function update(values: Record<string, unknown>) {
    const statement = { values, filters: [] as Array<[string, unknown]> };
    updates.push(statement);
    let returnsRows = false;

    const query = {
      eq(column: string, value: unknown) {
        statement.filters.push([column, value]);
        return query;
      },
      in(column: string, candidates: unknown[]) {
        statement.filters.push([column, candidates]);
        return query;
      },
      select() {
        returnsRows = true;
        return query;
      },
      then<Result>(resolve: (result: { data: Array<{ id: string }> | null; error: null }) => Result) {
        const matched = rows.filter((row) => statement.filters.every(([column, expected]) => {
          const actual = (row as Record<string, unknown>)[column];
          return Array.isArray(expected) ? expected.includes(actual) : actual === expected;
        }));
        for (const row of matched) {
          Object.assign(row, values);
        }

        return Promise.resolve({
          data: returnsRows ? matched.map((row) => ({ id: row.id })) : null,
          error: null,
        }).then(resolve);
      },
    };

    return query;
  }

  return { rows, updates, update };
}

const DEVICE_NOT_REGISTERED = {
  status: 'error',
  message: 'The recipient device is not registered with FCM.',
  details: { error: 'DeviceNotRegistered' },
};

/**
 * The tables the receipts job and the retry job touch. Both read
 * `mobile_push_deliveries`; the retry job's read is the one that filters on
 * `send_status`.
 */
function createPushMaintenanceSupabase({
  pendingDeliveries = [],
  retryableDeliveries = [],
  tokens,
}: {
  pendingDeliveries?: Record<string, unknown>[];
  retryableDeliveries?: Record<string, unknown>[];
  tokens: PushTokenState[];
}) {
  const tokenTable = createPushTokenTable(tokens);
  const deliveryUpdates: Array<{ id: string; values: Record<string, unknown> }> = [];

  const adminSupabase = {
    from(table: string) {
      if (table === 'mobile_push_deliveries') {
        return {
          select() {
            let rows = pendingDeliveries;
            const query = {
              eq(column: string) {
                if (column === 'send_status') {
                  rows = retryableDeliveries;
                }
                return query;
              },
              lte: () => query,
              is: () => query,
              lt: () => query,
              order: () => query,
              limit: async () => ({ data: rows, error: null }),
            };
            return query;
          },
          update(values: Record<string, unknown>) {
            return {
              eq(_column: string, value: unknown) {
                deliveryUpdates.push({ id: String(value), values });
                return Promise.resolve({ error: null });
              },
            };
          },
        };
      }

      if (table === 'mobile_notifications') {
        return {
          select() {
            return {
              eq(_column: string, value: unknown) {
                return {
                  async maybeSingle() {
                    return {
                      data: {
                        id: value,
                        type: 'generation_succeeded',
                        category: 'generation',
                        title: 'Render ready',
                        body: 'Open it in the app.',
                        deep_link: '/viewer?source=studio-creations&initialId=gen-1',
                      },
                      error: null,
                    };
                  },
                };
              },
            };
          },
        };
      }

      if (table === 'mobile_push_tokens') {
        return { update: tokenTable.update };
      }

      throw new Error(`Unexpected table ${table}`);
    },
    async rpc(name: string) {
      expect(name).toBe('prune_mobile_notification_retention');
      return {
        data: { deliveriesDeleted: 0, notificationsDeleted: 0, batchLimitReached: false },
        error: null,
      };
    },
  };

  return { adminSupabase, tokenTable, deliveryUpdates };
}

function expoResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}

function sentBodies(fetchMock: { mock: { calls: Parameters<typeof fetch>[] } }) {
  return fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

/**
 * The tables one push fan-out touches, for an account holding `tokens`. Writes
 * are recorded as they arrive, so a test can count statements as well as rows.
 */
function createPushFanOutSupabase(tokens: PushTokenRow[]) {
  const tokenFilters: Array<[string, unknown]> = [];
  const deliveryInsertCalls: Array<Record<string, unknown>[]> = [];
  // Every token the fan-out loads is live at the moment it is read.
  const tokenTable = createPushTokenTable(tokens.map((token) => ({
    id: token.id,
    is_active: true,
    disabled_at: null,
  })));
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
                        user_id: values.user_id,
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
                        created_at: '2026-10-01T14:36:18.000Z',
                        updated_at: '2026-10-01T14:36:18.000Z',
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
              eq(_column: string, value: unknown) {
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
              eq() {
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
            const query = {
              error: null,
              data: tokens,
              eq(column: string, value: unknown) {
                tokenFilters.push([column, value]);
                return query;
              },
            };
            return query;
          },
          update: tokenTable.update,
        };
      }

      if (table === 'mobile_push_deliveries') {
        return {
          async insert(values: Record<string, unknown> | Record<string, unknown>[]) {
            deliveryInsertCalls.push([values].flat());
            return { error: null };
          },
        };
      }

      throw new Error(`Unexpected table ${table}`);
    },
  };

  return {
    adminSupabase,
    tokenFilters,
    deliveryInsertCalls,
    tokenTable,
    tokenUpdates: tokenTable.updates,
    notificationUpdates,
  };
}

function unlockNotification(adminSupabase: unknown) {
  return createMobileNotification({
    adminSupabase: adminSupabase as never,
    userId: 'user-1',
    type: 'post_resource_unlocked',
    category: 'commerce',
    title: 'Post resources unlocked',
    body: 'The prompt, files, or workflow are ready to view.',
    deepLink: '/viewer?source=showcase-feed&initialId=post-1',
    objectType: 'post',
    objectId: 'post-1',
  });
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

  // `updatedAt` is the age the app prints. The row's own updated_at is stamped
  // by every write, reading the alert included, so it must never feed it.
  it("reports an alert's last event as updatedAt, not the last write to its row", () => {
    expect(toMobileNotificationRecord({
      id: 'notification-1',
      type: 'post_saved',
      category: 'social',
      event_count: 3,
      is_read: true,
      created_at: '2026-06-22T06:00:00.000Z',
      last_event_at: '2026-06-22T06:10:00.000Z',
      updated_at: '2026-06-22T09:00:00.000Z',
    })).toMatchObject({
      createdAt: '2026-06-22T06:00:00.000Z',
      updatedAt: '2026-06-22T06:10:00.000Z',
    });
  });

  it('falls back to the arrival time for a row read without its last event', () => {
    expect(toMobileNotificationRecord({
      id: 'notification-1',
      created_at: '2026-06-22T06:00:00.000Z',
      updated_at: '2026-06-22T09:00:00.000Z',
    }).updatedAt).toBe('2026-06-22T06:00:00.000Z');
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
    const tokenTable = createPushTokenTable([
      { id: 'token-1', is_active: true, disabled_at: null },
      { id: 'token-2', is_active: true, disabled_at: null },
    ]);
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
          return { update: tokenTable.update };
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
    // The token the receipt names is retired at the time of this run; the
    // account's other device is left alone.
    expect(tokenTable.rows).toEqual([
      { id: 'token-1', is_active: false, disabled_at: '2026-05-26T12:00:00.000Z' },
      { id: 'token-2', is_active: true, disabled_at: null },
    ]);
  });

  // disabled_at is written and never read: its whole use is working out, later,
  // when a token stopped receiving pushes. A dead token keeps collecting
  // DeviceNotRegistered receipts for every push still in flight to it, and each
  // one used to move that time forward to its own run.
  it('keeps the time a token was retired when a later receipt reports it gone again', async () => {
    const maintenance = createPushMaintenanceSupabase({
      pendingDeliveries: [{
        id: 'delivery-2',
        token_id: 'token-1',
        push_ticket_id: 'ticket-2',
        receipt_status: 'pending',
        sent_at: '2026-10-01T11:00:00.000Z',
      }],
      tokens: [{ id: 'token-1', is_active: false, disabled_at: '2026-10-01T10:30:00.000Z' }],
    });
    const fetcher = vi.fn<typeof fetch>(async () => expoResponse({
      data: { 'ticket-2': DEVICE_NOT_REGISTERED },
    }));

    await expect(processPendingMobilePushReceipts(maintenance.adminSupabase as never, {
      fetcher,
      now: new Date('2026-10-01T12:00:00.000Z'),
    })).resolves.toEqual({
      checkedCount: 1,
      updatedCount: 1,
      staleCount: 0,
      disabledTokenCount: 0,
    });

    expect(maintenance.tokenTable.updates).toHaveLength(1);
    expect(maintenance.tokenTable.updates[0]?.filters).toContainEqual(['is_active', true]);
    expect(maintenance.tokenTable.rows).toEqual([
      { id: 'token-1', is_active: false, disabled_at: '2026-10-01T10:30:00.000Z' },
    ]);
    // The delivery itself still records what Expo said about it.
    expect(maintenance.deliveryUpdates).toEqual([
      {
        id: 'delivery-2',
        values: expect.objectContaining({
          receipt_status: 'error',
          receipt_error_code: 'DeviceNotRegistered',
          receipt_checked_at: '2026-10-01T12:00:00.000Z',
        }),
      },
    ]);
  });

  it('counts the tokens a receipts run retired, not the receipts that named them', async () => {
    const pending = (id: string, tokenId: string) => ({
      id: `delivery-${id}`,
      token_id: tokenId,
      push_ticket_id: `ticket-${id}`,
      receipt_status: 'pending',
      sent_at: '2026-10-01T11:00:00.000Z',
    });
    const maintenance = createPushMaintenanceSupabase({
      pendingDeliveries: [
        pending('1', 'token-1'),
        pending('2', 'token-1'),
        pending('3', 'token-1'),
        pending('4', 'token-2'),
      ],
      tokens: [
        { id: 'token-1', is_active: true, disabled_at: null },
        { id: 'token-2', is_active: true, disabled_at: null },
      ],
    });
    const fetcher = vi.fn<typeof fetch>(async () => expoResponse({
      data: {
        'ticket-1': DEVICE_NOT_REGISTERED,
        'ticket-2': DEVICE_NOT_REGISTERED,
        'ticket-3': DEVICE_NOT_REGISTERED,
        'ticket-4': { status: 'ok' },
      },
    }));

    await expect(processPendingMobilePushReceipts(maintenance.adminSupabase as never, {
      fetcher,
      now: new Date('2026-10-01T12:00:00.000Z'),
    })).resolves.toEqual({
      checkedCount: 4,
      updatedCount: 4,
      staleCount: 0,
      disabledTokenCount: 1,
    });

    expect(maintenance.tokenTable.rows).toEqual([
      { id: 'token-1', is_active: false, disabled_at: '2026-10-01T12:00:00.000Z' },
      { id: 'token-2', is_active: true, disabled_at: null },
    ]);
  });

  // A push Expo refuses at send is filed as a failed send with no ticket, which
  // is what the retry job picks up. The send path has already retired that
  // token, so the next two runs each asked Expo again and each moved the
  // token's disabled_at on to their own time.
  it('leaves a token the send path already retired when the retry job is refused again', async () => {
    const maintenance = createPushMaintenanceSupabase({
      retryableDeliveries: [{
        id: 'delivery-1',
        notification_id: 'notification-1',
        user_id: 'user-1',
        token_id: 'token-1',
        expo_push_token: 'ExponentPushToken[gone]',
        platform: 'android',
        attempt_count: 1,
      }],
      tokens: [{ id: 'token-1', is_active: false, disabled_at: '2026-10-01T14:36:18.412Z' }],
    });
    const fetcher = vi.fn<typeof fetch>(async () => expoResponse({ data: DEVICE_NOT_REGISTERED }));

    await expect(processMobilePushMaintenance(maintenance.adminSupabase as never, {
      fetcher,
      now: new Date('2026-10-01T14:40:00.000Z'),
    })).resolves.toMatchObject({
      retryableCount: 1,
      retriedCount: 1,
      resentCount: 0,
      retryFailedCount: 1,
      retryDisabledTokenCount: 0,
      disabledTokenCount: 0,
    });

    expect(sentBodies(fetcher)).toEqual([
      expect.objectContaining({ to: 'ExponentPushToken[gone]', title: 'Render ready' }),
    ]);
    expect(maintenance.tokenTable.updates).toHaveLength(1);
    expect(maintenance.tokenTable.updates[0]?.filters).toContainEqual(['is_active', true]);
    expect(maintenance.tokenTable.rows).toEqual([
      { id: 'token-1', is_active: false, disabled_at: '2026-10-01T14:36:18.412Z' },
    ]);
    expect(maintenance.deliveryUpdates).toEqual([
      {
        id: 'delivery-1',
        values: expect.objectContaining({
          receipt_error_code: 'DeviceNotRegistered',
          attempt_count: 2,
          last_attempt_at: '2026-10-01T14:40:00.000Z',
        }),
      },
    ]);
  });

  // The first send was turned down for a reason of its own (Expo's rate limit,
  // say), which says nothing about the device: the retry is the first to hear
  // that it is gone.
  it('retires a live token the retry job finds gone, and counts it once', async () => {
    const maintenance = createPushMaintenanceSupabase({
      retryableDeliveries: [{
        id: 'delivery-1',
        notification_id: 'notification-1',
        user_id: 'user-1',
        token_id: 'token-1',
        expo_push_token: 'ExponentPushToken[gone]',
        platform: 'android',
        attempt_count: 1,
      }],
      tokens: [
        { id: 'token-1', is_active: true, disabled_at: null },
        { id: 'token-2', is_active: true, disabled_at: null },
      ],
    });
    const fetcher = vi.fn<typeof fetch>(async () => expoResponse({ data: DEVICE_NOT_REGISTERED }));

    await expect(processMobilePushMaintenance(maintenance.adminSupabase as never, {
      fetcher,
      now: new Date('2026-10-01T14:40:00.000Z'),
    })).resolves.toMatchObject({
      retriedCount: 1,
      retryFailedCount: 1,
      retryDisabledTokenCount: 1,
      disabledTokenCount: 1,
    });

    expect(maintenance.tokenTable.rows).toEqual([
      { id: 'token-1', is_active: false, disabled_at: '2026-10-01T14:40:00.000Z' },
      { id: 'token-2', is_active: true, disabled_at: null },
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
            async insert(values: Record<string, unknown>[]) {
              deliveryInserts.push(...values);
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

  // Production, 2026-10-01: one unlock notification to an account holding 32
  // active tokens made 32 Expo requests and 32 inserts in turn, 14.1 seconds in
  // all, inside the request of the person who unlocked the post.
  it('sends every device on an account in one Expo request and one ledger write', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => expoResponse({
      data: [
        { status: 'ok', id: 'ticket-1' },
        {
          status: 'error',
          message: 'The recipient device is not registered with FCM.',
          details: { error: 'DeviceNotRegistered' },
        },
        { status: 'ok', id: 'ticket-3' },
        {
          status: 'error',
          message: 'Unable to retrieve the FCM server key for the recipient\'s app.',
          details: { error: 'InvalidCredentials' },
        },
      ],
    }));
    vi.stubGlobal('fetch', fetchMock);
    const fanOut = createPushFanOutSupabase([
      { id: 'token-1', expo_push_token: 'ExponentPushToken[phone]', platform: 'android' },
      { id: 'token-2', expo_push_token: 'ExponentPushToken[gone]', platform: 'android' },
      { id: 'token-3', expo_push_token: 'ExponentPushToken[tablet]', platform: 'ios' },
      { id: 'token-4', expo_push_token: 'ExponentPushToken[devbuild]', platform: 'android' },
    ]);

    await unlockNotification(fanOut.adminSupabase);

    expect(fanOut.tokenFilters).toEqual([['user_id', 'user-1'], ['is_active', true]]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('https://exp.host/--/api/v2/push/send', expect.objectContaining({
      method: 'POST',
    }));
    const message = {
      title: 'Post resources unlocked',
      body: 'The prompt, files, or workflow are ready to view.',
      sound: 'default',
      channelId: 'default',
      priority: 'high',
      data: {
        notificationId: 'notification-1',
        type: 'post_resource_unlocked',
        category: 'commerce',
        deepLink: '/viewer?source=showcase-feed&initialId=post-1',
      },
    };
    expect(sentBodies(fetchMock)).toEqual([[
      { to: 'ExponentPushToken[phone]', ...message },
      { to: 'ExponentPushToken[gone]', ...message },
      { to: 'ExponentPushToken[tablet]', ...message },
      { to: 'ExponentPushToken[devbuild]', ...message },
    ]]);

    expect(fanOut.deliveryInsertCalls).toHaveLength(1);
    expect(fanOut.deliveryInsertCalls[0]).toEqual([
      expect.objectContaining({
        notification_id: 'notification-1',
        user_id: 'user-1',
        token_id: 'token-1',
        expo_push_token: 'ExponentPushToken[phone]',
        platform: 'android',
        push_ticket_id: 'ticket-1',
        send_status: 'sent',
        receipt_status: 'pending',
        attempt_count: 1,
      }),
      expect.objectContaining({
        token_id: 'token-2',
        expo_push_token: 'ExponentPushToken[gone]',
        platform: 'android',
        send_status: 'error',
        receipt_status: 'error',
        receipt_error_code: 'DeviceNotRegistered',
        receipt_message: 'The recipient device is not registered with FCM.',
        provider_details: { error: 'DeviceNotRegistered' },
        attempt_count: 1,
      }),
      expect.objectContaining({
        token_id: 'token-3',
        expo_push_token: 'ExponentPushToken[tablet]',
        platform: 'ios',
        push_ticket_id: 'ticket-3',
        send_status: 'sent',
        receipt_status: 'pending',
      }),
      expect.objectContaining({
        token_id: 'token-4',
        send_status: 'error',
        receipt_status: 'error',
        receipt_error_code: 'InvalidCredentials',
        attempt_count: 1,
      }),
    ]);
    // Only the device Expo reports as gone is retired. InvalidCredentials
    // describes the project's push credentials, not the device: retiring on it
    // would empty the table the day a key was revoked.
    expect(fanOut.tokenUpdates).toEqual([
      {
        values: { is_active: false, disabled_at: expect.any(String) },
        filters: [['id', ['token-2']], ['is_active', true]],
      },
    ]);
    expect(fanOut.tokenTable.rows).toEqual([
      { id: 'token-1', is_active: true, disabled_at: null },
      { id: 'token-2', is_active: false, disabled_at: expect.any(String) },
      { id: 'token-3', is_active: true, disabled_at: null },
      { id: 'token-4', is_active: true, disabled_at: null },
    ]);
    expect(fanOut.notificationUpdates).toEqual([
      {
        id: 'notification-1',
        values: {
          pushed_at: expect.any(String),
          push_ticket_id: 'ticket-1',
          push_error: 'The recipient device is not registered with FCM.',
        },
      },
    ]);
  });

  // The fan-out reads its tokens before it calls Expo. A sign-out on that phone,
  // or a receipt for an earlier push, can retire one in between.
  it('keeps the time a token was retired while a push to it was in flight', async () => {
    const fanOut = createPushFanOutSupabase([
      { id: 'token-1', expo_push_token: 'ExponentPushToken[gone]', platform: 'android' },
    ]);
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => {
      Object.assign(fanOut.tokenTable.rows[0], {
        is_active: false,
        disabled_at: '2026-10-01T04:05:39.271Z',
      });
      return expoResponse({ data: [DEVICE_NOT_REGISTERED] });
    }));

    await unlockNotification(fanOut.adminSupabase);

    expect(fanOut.tokenUpdates).toHaveLength(1);
    expect(fanOut.tokenUpdates[0]?.filters).toContainEqual(['is_active', true]);
    expect(fanOut.tokenTable.rows).toEqual([
      { id: 'token-1', is_active: false, disabled_at: '2026-10-01T04:05:39.271Z' },
    ]);
    // The fan-out still ran to its end: the refusal is on the ledger and on the
    // notification.
    expect(fanOut.deliveryInsertCalls).toEqual([[
      expect.objectContaining({ token_id: 'token-1', receipt_error_code: 'DeviceNotRegistered' }),
    ]]);
    expect(fanOut.notificationUpdates).toHaveLength(1);
  });

  it('splits an account past Expo\'s 100-message limit into as few requests as it allows', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const messages = JSON.parse(String(init?.body)) as Array<{ to: string }>;
      return expoResponse({
        data: messages.map((message) => ({ status: 'ok', id: `ticket-for-${message.to}` })),
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const tokens = Array.from({ length: 101 }, (_, index): PushTokenRow => ({
      id: `token-${index}`,
      expo_push_token: `ExponentPushToken[device${index}]`,
      platform: 'android',
    }));
    const fanOut = createPushFanOutSupabase(tokens);

    await unlockNotification(fanOut.adminSupabase);

    expect(sentBodies(fetchMock).map((messages) => messages.length)).toEqual([100, 1]);
    // Each request's tickets are written before the next request goes out.
    expect(fanOut.deliveryInsertCalls.map((rows) => rows.length)).toEqual([100, 1]);
    // Tickets are matched to tokens by position, on both sides of the boundary.
    expect(fanOut.deliveryInsertCalls[0]?.[99]).toMatchObject({
      token_id: 'token-99',
      push_ticket_id: 'ticket-for-ExponentPushToken[device99]',
    });
    expect(fanOut.deliveryInsertCalls[1]?.[0]).toMatchObject({
      token_id: 'token-100',
      push_ticket_id: 'ticket-for-ExponentPushToken[device100]',
    });
    expect(fanOut.tokenUpdates).toEqual([]);
  });

  // Expo answers per request, not per message, when a batch as a whole is
  // unacceptable — one token from another Expo project is enough. Sent one by
  // one, that token used to fail alone, and it still must.
  it('sends a refused batch again one device at a time so one bad token cannot silence the rest', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { to: string } | Array<{ to: string }>;
      if (Array.isArray(body)) {
        return expoResponse({
          errors: [{
            code: 'PUSH_TOO_MANY_EXPERIENCE_IDS',
            message: 'All push notification messages in the same request must be for the same project.',
          }],
        }, 400);
      }
      return body.to === 'ExponentPushToken[otherproject]'
        ? expoResponse({ errors: [{ message: 'The token belongs to another project.' }] }, 400)
        : expoResponse({ data: { status: 'ok', id: 'ticket-phone' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const fanOut = createPushFanOutSupabase([
      { id: 'token-1', expo_push_token: 'ExponentPushToken[otherproject]', platform: 'android' },
      { id: 'token-2', expo_push_token: 'ExponentPushToken[phone]', platform: 'android' },
    ]);

    await unlockNotification(fanOut.adminSupabase);

    expect(sentBodies(fetchMock).map((body) => (Array.isArray(body) ? body.length : body.to))).toEqual([
      2,
      'ExponentPushToken[otherproject]',
      'ExponentPushToken[phone]',
    ]);
    expect(fanOut.deliveryInsertCalls).toHaveLength(1);
    expect(fanOut.deliveryInsertCalls[0]).toEqual([
      expect.objectContaining({
        token_id: 'token-1',
        send_status: 'error',
        receipt_status: 'error',
        provider_message: 'The token belongs to another project.',
      }),
      expect.objectContaining({
        token_id: 'token-2',
        push_ticket_id: 'ticket-phone',
        send_status: 'sent',
        receipt_status: 'pending',
      }),
    ]);
    expect(fanOut.tokenUpdates).toEqual([]);
  });

  it('does not resend a single-device batch that Expo refused', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => expoResponse({
      errors: [{ message: 'The token belongs to another project.' }],
    }, 400));
    vi.stubGlobal('fetch', fetchMock);
    const fanOut = createPushFanOutSupabase([
      { id: 'token-1', expo_push_token: 'ExponentPushToken[otherproject]', platform: 'android' },
    ]);

    await unlockNotification(fanOut.adminSupabase);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fanOut.deliveryInsertCalls).toEqual([[
      expect.objectContaining({
        token_id: 'token-1',
        send_status: 'error',
        receipt_status: 'error',
        provider_message: 'The token belongs to another project.',
        attempt_count: 1,
      }),
    ]]);
  });

  it('reads one ticket per message from a batched Expo send, in the order it was sent', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => expoResponse({
      data: [
        { status: 'ok', id: 'ticket-1' },
        { status: 'error', message: 'Not registered', details: { error: 'DeviceNotRegistered' } },
      ],
    }));

    await expect(sendExpoPushNotificationBatch({
      expoPushTokens: ['ExponentPushToken[a]', 'ExponentPushToken[b]'],
      title: 'Render ready',
      body: 'Your image finished.',
      data: { notificationId: 'notification-1' },
      fetcher,
    })).resolves.toEqual([
      { status: 'ok', id: 'ticket-1' },
      { status: 'error', message: 'Not registered', details: { error: 'DeviceNotRegistered' } },
    ]);
    expect(sentBodies(fetcher)).toEqual([[
      expect.objectContaining({ to: 'ExponentPushToken[a]', title: 'Render ready' }),
      expect.objectContaining({ to: 'ExponentPushToken[b]', title: 'Render ready' }),
    ]]);
  });

  // Tickets carry no token, only a position. A list of the wrong length cannot
  // be matched to devices, and a guess could retire the wrong one.
  it('refuses a ticket list that does not line up with the messages it sent', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => expoResponse({
      data: [{ status: 'ok', id: 'ticket-1' }],
    }));

    await expect(sendExpoPushNotificationBatch({
      expoPushTokens: ['ExponentPushToken[a]', 'ExponentPushToken[b]'],
      title: 'Render ready',
      body: 'Your image finished.',
      data: { notificationId: 'notification-1' },
      fetcher,
    })).rejects.toMatchObject({
      name: 'MobileNotificationError',
      status: 502,
    });
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
