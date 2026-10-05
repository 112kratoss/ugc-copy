import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MobileNotificationError,
  buildMobileNotificationDeepLink,
  createMobileNotification,
  hasMobilePushMaintenanceWork,
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
type PushTokenState = {
  id: string;
  is_active: boolean;
  disabled_at: string | null;
  // Whose token it is and the token itself: what the retry job asks about
  // before it sends again. The retirement paths read neither.
  user_id?: string;
  expo_push_token?: string;
};

/**
 * `mobile_push_tokens` as the three retirement paths and the retry job see it.
 * An update changes only the rows its filters match and, when asked to, hands
 * those rows back, and a read returns only the row its filters match, so a test
 * can read what became of a row as well as which filters were sent.
 */
function createPushTokenTable(
  rows: PushTokenState[],
  { readError = null }: { readError?: { message: string } | null } = {},
) {
  const updates: Array<{ values: Record<string, unknown>; filters: Array<[string, unknown]> }> = [];
  const reads: Array<Array<[string, unknown]>> = [];

  function matching(filters: Array<[string, unknown]>) {
    return rows.filter((row) => filters.every(([column, expected]) => {
      const actual = (row as Record<string, unknown>)[column];
      return Array.isArray(expected) ? expected.includes(actual) : actual === expected;
    }));
  }

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
        const matched = matching(statement.filters);
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

  function select() {
    const filters: Array<[string, unknown]> = [];
    reads.push(filters);

    const query = {
      eq(column: string, value: unknown) {
        filters.push([column, value]);
        return query;
      },
      async maybeSingle() {
        if (readError) {
          return { data: null, error: readError };
        }
        const [row] = matching(filters);
        return { data: row ? { id: row.id } : null, error: null };
      },
    };

    return query;
  }

  return { rows, updates, reads, update, select };
}

type PreferencesState = {
  user_id: string;
  push_enabled: boolean;
  generation_enabled: boolean;
  commerce_enabled: boolean;
  social_enabled: boolean;
};

/** user-1's preferences as the first send leaves them: every switch at its default. */
const ALERTS_ON: PreferencesState = {
  user_id: 'user-1',
  push_enabled: true,
  generation_enabled: true,
  commerce_enabled: true,
  social_enabled: true,
};

/**
 * `mobile_notification_preferences` as the retry job sees it. A read hands back
 * the columns it asked for, from the row its filters match, or nothing. A write
 * is recorded and makes the row the database would, so a test can tell a job
 * that only reads from one that leaves rows behind.
 */
function createPreferencesTable(
  rows: PreferencesState[],
  { readError = null }: { readError?: { message: string } | null } = {},
) {
  const reads: Array<Array<[string, unknown]>> = [];
  const writes: Record<string, unknown>[] = [];

  function pick(row: PreferencesState, columns: string) {
    return Object.fromEntries(columns.split(',').map((column) => {
      const name = column.trim();
      return [name, (row as Record<string, unknown>)[name]];
    }));
  }

  function select(columns: string) {
    const filters: Array<[string, unknown]> = [];
    reads.push(filters);

    const query = {
      eq(column: string, value: unknown) {
        filters.push([column, value]);
        return query;
      },
      async maybeSingle() {
        if (readError) {
          return { data: null, error: readError };
        }
        const row = rows.find((candidate) => filters.every(([column, expected]) => (
          (candidate as Record<string, unknown>)[column] === expected
        )));
        return { data: row ? pick(row, columns) : null, error: null };
      },
    };

    return query;
  }

  function upsert(values: Record<string, unknown>) {
    writes.push(values);
    const row = { ...ALERTS_ON, ...values } as PreferencesState;
    rows.push(row);

    return {
      select(columns: string) {
        return { single: async () => ({ data: pick(row, columns), error: null }) };
      },
    };
  }

  return { rows, reads, writes, select, upsert };
}

const DEVICE_NOT_REGISTERED = {
  status: 'error',
  message: 'The recipient device is not registered with FCM.',
  details: { error: 'DeviceNotRegistered' },
};

/**
 * The tables the receipts job and the retry job touch.
 *
 * `mobile_push_deliveries` is one table here as it is in the database: a read
 * returns the rows its filters match and an update changes the row it names, so
 * a test can ask what the next run would find as well as what this one wrote.
 * A row handed in as retryable is filed the way the send path files a failed
 * send it leaves open; `storeDeliveries` takes rows exactly as they were
 * written and gives them the id the database would.
 *
 * Unless a test says otherwise, user-1 holds the preferences row the first send
 * made, and every notification is the same finished render; `notification`
 * changes what kind of alert it is.
 */
function createPushMaintenanceSupabase({
  pendingDeliveries = [],
  retryableDeliveries = [],
  tokens,
  tokenReadError = null,
  preferences = [{ ...ALERTS_ON }],
  preferencesReadError = null,
  deliveryWriteError = null,
  notification = {},
}: {
  pendingDeliveries?: Record<string, unknown>[];
  retryableDeliveries?: Record<string, unknown>[];
  tokens: PushTokenState[];
  tokenReadError?: { message: string } | null;
  preferences?: PreferencesState[];
  preferencesReadError?: { message: string } | null;
  deliveryWriteError?: { message: string } | null;
  notification?: Record<string, unknown>;
}) {
  const tokenTable = createPushTokenTable(tokens, { readError: tokenReadError });
  const preferenceTable = createPreferencesTable(preferences, { readError: preferencesReadError });
  const deliveries: Record<string, unknown>[] = [
    ...pendingDeliveries.map((row) => ({ ...row })),
    ...retryableDeliveries.map((row) => ({
      send_status: 'error',
      receipt_status: 'error',
      push_ticket_id: null,
      ...row,
    })),
  ];
  const deliveryUpdates: Array<{ id: string; values: Record<string, unknown> }> = [];

  function storeDeliveries(rows: Record<string, unknown>[]) {
    for (const row of rows) {
      deliveries.push({ id: `delivery-${deliveries.length + 1}`, ...row });
    }
  }

  const adminSupabase = {
    from(table: string) {
      if (table === 'mobile_push_deliveries') {
        return {
          select() {
            const tests: Array<(row: Record<string, unknown>) => boolean> = [];
            const query = {
              eq(column: string, value: unknown) {
                tests.push((row) => row[column] === value);
                return query;
              },
              not(column: string, _operator: string, value: unknown) {
                tests.push(row => (row[column] ?? null) !== value);
                return query;
              },
              is(column: string, value: unknown) {
                tests.push((row) => (row[column] ?? null) === value);
                return query;
              },
              // As in SQL, a missing value is neither below nor above anything.
              lt(column: string, value: string | number) {
                tests.push((row) => row[column] != null && (row[column] as string | number) < value);
                return query;
              },
              lte(column: string, value: string | number) {
                tests.push((row) => row[column] != null && (row[column] as string | number) <= value);
                return query;
              },
              order: () => query,
              limit: async (count: number) => ({
                data: deliveries
                  .filter((row) => tests.every((test) => test(row)))
                  .slice(0, count)
                  .map((row) => ({ ...row })),
                error: null,
              }),
            };
            return query;
          },
          update(values: Record<string, unknown>) {
            const filters: Array<[string, unknown]> = [];
            const query = {
              eq(column: string, value: unknown) { filters.push([column, value]); return query; },
              is(column: string, value: unknown) { filters.push([column, value]); return query; },
              then(resolve: (result: { error: { message: string } | null }) => unknown) {
                deliveryUpdates.push({ id: String(filters.find(([column]) => column === 'id')?.[1]), values });
                if (!deliveryWriteError) for (const row of deliveries) {
                  if (filters.every(([column, value]) => (row[column] ?? null) === value)) Object.assign(row, values);
                }
                return Promise.resolve({error: deliveryWriteError}).then(resolve);
              },
            };
            return query;
          },
        };
      }

      if (table === 'mobile_notifications') {
        return {
          select() {
            let notificationId: unknown = null;
            const query = {
              eq(column: string, value: unknown) {
                if (column === 'id') {
                  notificationId = value;
                }
                return query;
              },
              lt: () => query,
              // The retention check: no read notification is old enough to prune.
              limit: async () => ({ data: [], error: null }),
              async maybeSingle() {
                return {
                  data: {
                    id: notificationId,
                    type: 'generation_succeeded',
                    category: 'generation',
                    title: 'Render ready',
                    body: 'Open it in the app.',
                    deep_link: '/viewer?source=studio-creations&initialId=gen-1',
                    ...notification,
                  },
                  error: null,
                };
              },
            };
            return query;
          },
        };
      }

      if (table === 'mobile_push_tokens') {
        return { update: tokenTable.update, select: tokenTable.select };
      }

      if (table === 'mobile_notification_preferences') {
        return { select: preferenceTable.select, upsert: preferenceTable.upsert };
      }

      throw new Error(`Unexpected table ${table}`);
    },
    async rpc(name: string, args: Record<string, unknown> = {}) {
      const row = deliveries.find(row => row.id === args.p_delivery_id);
      if (name === 'claim_mobile_push_retry') {
        if (!row || row.retry_claim_id || row.attempt_count !== args.p_expected_attempt_count) return { data: null, error: null };
        row.attempt_count = Number(row.attempt_count) + 1;
        row.retry_claim_id = 'claim-' + row.id;
        row.last_attempt_at = new Date().toISOString();
        return { data: row.retry_claim_id, error: null };
      }
      if (name === 'record_mobile_push_retry_outcome') {
        const outcome = args.p_outcome as Record<string, unknown>;
        deliveryUpdates.push({ id: String(args.p_delivery_id), values: outcome });
        if (deliveryWriteError) return { data: null, error: deliveryWriteError };
        if (!row || row.retry_claim_id !== args.p_claim_id) return { data: false, error: null };
        row.retry_outcome = outcome;
        return { data: true, error: null };
      }
      if (name === 'finish_mobile_push_retry') {
        const outcome = row?.retry_outcome as Record<string, unknown>;
        if (!outcome) return { data: { applied: false }, error: null };
        if (!row || row.retry_claim_id !== args.p_claim_id) return { data: { applied: false }, error: null };
        let disabledTokenCount = 0;
        if (outcome.error_code === 'DeviceNotRegistered') {
          const token = tokenTable.rows.find(token => token.user_id === row.user_id && token.expo_push_token === row.expo_push_token);
          if (token) {
            const result = await tokenTable.update({ is_active: false, disabled_at: new Date().toISOString() }).in('id', [token.id]).eq('is_active', true).select();
            disabledTokenCount = result.data?.length ?? 0;
          }
        }
        Object.assign(row, {
          retry_claim_id: null, retry_outcome: null,
          send_status: outcome.status === 'sent' ? 'sent' : 'error',
          receipt_status: outcome.status === 'sent' ? 'pending' : outcome.status === 'refused' ? 'stale' : 'error',
          push_ticket_id: outcome.ticket_id ?? null,
          receipt_error_code: outcome.error_code ?? null,
          provider_message: outcome.message ?? null,
          sent_at: outcome.status === 'sent' ? new Date().toISOString() : row.sent_at,
        });
        return { data: { applied: true, disabledTokenCount }, error: null };
      }
      expect(name).toBe('prune_mobile_notification_retention');
      return {
        data: { deliveriesDeleted: 0, notificationsDeleted: 0, batchLimitReached: false },
        error: null,
      };
    },
  };

  return { adminSupabase, tokenTable, preferenceTable, deliveries, deliveryUpdates, storeDeliveries };
}

/** A failed send the retry job is due to pick up: tried once, on user-1's phone. */
function retryableDelivery(overrides: Record<string, unknown> = {}) {
  return {
    id: 'delivery-1',
    notification_id: 'notification-1',
    user_id: 'user-1',
    token_id: 'token-1',
    expo_push_token: 'ExponentPushToken[phone]',
    platform: 'android',
    attempt_count: 1,
    ...overrides,
  };
}

const PHONE_TOKEN = {
  id: 'token-1',
  user_id: 'user-1',
  expo_push_token: 'ExponentPushToken[phone]',
  is_active: true,
  disabled_at: null,
};

function refusedTicket(code?: string) {
  return {
    status: 'error',
    message: code ? `Expo refused the message: ${code}.` : 'Expo refused the message.',
    ...(code ? { details: { error: code } } : {}),
  };
}

// What Expo says that sending the same message again cannot change, against
// what it says to try again: its documentation tells senders to "slowly retry"
// after MessageRateExceeded, and ExpoError and ProviderError name a fault on
// its side or Apple's and Google's.
const PERMANENT_EXPO_ERRORS = [
  'DeviceNotRegistered',
  'InvalidCredentials',
  'MismatchSenderId',
  'MessageTooBig',
  'DeveloperError',
];
const PASSING_EXPO_ERRORS = ['MessageRateExceeded', 'ExpoError', 'ProviderError', undefined].map((code) => ({
  code,
  reason: code ?? 'no reason given',
}));

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

  // A push Expo refused at send used to be filed where the retry job picks it
  // up, and the job never looked at the token row. The send path had already
  // retired this token, yet each of the next two runs asked Expo about it
  // again. Rows filed that way are still on the ledger when this ships.
  it('does not ask Expo again about a refusal whose token is already retired', async () => {
    const maintenance = createPushMaintenanceSupabase({
      retryableDeliveries: [retryableDelivery({
        expo_push_token: 'ExponentPushToken[gone]',
        receipt_error_code: 'DeviceNotRegistered',
      })],
      tokens: [{
        ...PHONE_TOKEN,
        expo_push_token: 'ExponentPushToken[gone]',
        is_active: false,
        disabled_at: '2026-10-01T14:36:18.412Z',
      }],
    });
    const fetcher = vi.fn<typeof fetch>(async () => expoResponse({ data: DEVICE_NOT_REGISTERED }));
    const now = new Date('2026-10-01T14:40:00.000Z');

    const summary = await processMobilePushMaintenance(maintenance.adminSupabase as never, { fetcher, now });

    expect(fetcher).not.toHaveBeenCalled();
    expect(summary).toMatchObject({
      retryableCount: 1,
      retriedCount: 0,
      retrySkippedCount: 1,
      resentCount: 0,
      retryFailedCount: 0,
      retryDisabledTokenCount: 0,
      disabledTokenCount: 0,
    });
    // Nothing is written to the token: it keeps the time the send path gave it.
    expect(maintenance.tokenTable.updates).toEqual([]);
    expect(maintenance.tokenTable.rows).toEqual([{
      ...PHONE_TOKEN,
      expo_push_token: 'ExponentPushToken[gone]',
      is_active: false,
      disabled_at: '2026-10-01T14:36:18.412Z',
    }]);
    // The delivery is closed where it stands. Its attempt count still says one
    // request was made, and what Expo said about it is kept.
    expect(maintenance.deliveryUpdates).toEqual([
      {
        id: 'delivery-1',
        values: {
          receipt_status: 'stale',
          receipt_checked_at: '2026-10-01T14:40:00.000Z',
          receipt_message: 'Not retried: the push token is no longer active for this account.',
        },
      },
    ]);
    expect(maintenance.deliveries).toEqual([
      expect.objectContaining({ attempt_count: 1, receipt_error_code: 'DeviceNotRegistered' }),
    ]);
    await expect(hasMobilePushMaintenanceWork(maintenance.adminSupabase as never, { now })).resolves.toBe(false);
  });

  // The first send was turned down for a reason of its own (Expo's rate limit,
  // say), which says nothing about the device: the retry is the first to hear
  // that it is gone.
  it('retires a live token the retry job finds gone, and counts it once', async () => {
    const maintenance = createPushMaintenanceSupabase({
      retryableDeliveries: [retryableDelivery({ expo_push_token: 'ExponentPushToken[gone]' })],
      tokens: [
        { ...PHONE_TOKEN, expo_push_token: 'ExponentPushToken[gone]' },
        { ...PHONE_TOKEN, id: 'token-2', expo_push_token: 'ExponentPushToken[tablet]' },
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
      {
        ...PHONE_TOKEN,
        expo_push_token: 'ExponentPushToken[gone]',
        is_active: false,
        disabled_at: expect.any(String),
      },
      { ...PHONE_TOKEN, id: 'token-2', expo_push_token: 'ExponentPushToken[tablet]' },
    ]);
  });

  // The token is live when the job checks it. A sign-out lands while the request
  // is with Expo, which answers that the device is gone.
  it('keeps the time a token was retired while its retry was in flight', async () => {
    const maintenance = createPushMaintenanceSupabase({
      retryableDeliveries: [retryableDelivery()],
      tokens: [{ ...PHONE_TOKEN }],
    });
    const fetcher = vi.fn<typeof fetch>(async () => {
      Object.assign(maintenance.tokenTable.rows[0], {
        is_active: false,
        disabled_at: '2026-10-04T05:09:59.000Z',
      });
      return expoResponse({ data: DEVICE_NOT_REGISTERED });
    });

    await expect(processMobilePushMaintenance(maintenance.adminSupabase as never, {
      fetcher,
      now: new Date('2026-10-04T05:10:00.000Z'),
    })).resolves.toMatchObject({
      retriedCount: 1,
      retryFailedCount: 1,
      retryDisabledTokenCount: 0,
      disabledTokenCount: 0,
    });

    expect(maintenance.tokenTable.updates).toHaveLength(1);
    expect(maintenance.tokenTable.updates[0]?.filters).toContainEqual(['is_active', true]);
    expect(maintenance.tokenTable.rows).toEqual([
      { ...PHONE_TOKEN, is_active: false, disabled_at: '2026-10-04T05:09:59.000Z' },
    ]);
  });

  it('re-sends a push whose token is still live for the account', async () => {
    const maintenance = createPushMaintenanceSupabase({
      retryableDeliveries: [retryableDelivery({ receipt_error_code: 'MessageRateExceeded' })],
      tokens: [
        { ...PHONE_TOKEN },
        { ...PHONE_TOKEN, id: 'token-2', user_id: 'user-2', expo_push_token: 'ExponentPushToken[other]' },
      ],
    });
    const fetcher = vi.fn<typeof fetch>(async () => expoResponse({ data: { status: 'ok', id: 'ticket-retry' } }));
    const now = new Date('2026-10-04T05:10:00.000Z');

    await expect(processMobilePushMaintenance(maintenance.adminSupabase as never, { fetcher, now })).resolves.toMatchObject({
      retryableCount: 1,
      retriedCount: 1,
      retrySkippedCount: 0,
      resentCount: 1,
      retryFailedCount: 0,
    });

    expect(sentBodies(fetcher)).toEqual([
      expect.objectContaining({
        to: 'ExponentPushToken[phone]',
        title: 'Render ready',
        body: 'Open it in the app.',
      }),
    ]);
    // What it asked before sending: is this token on a live row of this account?
    expect(maintenance.tokenTable.reads).toEqual([[
      ['user_id', 'user-1'],
      ['expo_push_token', 'ExponentPushToken[phone]'],
      ['is_active', true],
    ]]);
    expect(maintenance.deliveries).toEqual([
      expect.objectContaining({
        push_ticket_id: 'ticket-retry',
        send_status: 'sent',
        receipt_status: 'pending',
        attempt_count: 2,
        sent_at: expect.any(String),
      }),
    ]);
    // Its receipt is not due for fifteen minutes, and nothing is left to retry.
    await expect(hasMobilePushMaintenanceWork(maintenance.adminSupabase as never, { now })).resolves.toBe(false);
  });

  // The retry goes to the token string stored on the delivery, ten or twenty
  // minutes after the first attempt. In that time the token can leave the
  // account three ways, and after the last of them it is another account's
  // phone that would show this one's title and body.
  it.each([
    {
      how: 'the account signed out on that phone',
      tokens: [{ ...PHONE_TOKEN, is_active: false, disabled_at: '2026-10-04T05:02:00.000Z' }],
    },
    {
      how: 'the phone registered a newer token',
      tokens: [
        { ...PHONE_TOKEN, is_active: false, disabled_at: '2026-10-04T05:02:00.000Z' },
        { ...PHONE_TOKEN, id: 'token-2', expo_push_token: 'ExponentPushToken[reinstalled]' },
      ],
    },
    {
      how: 'another account signed in on that phone',
      tokens: [
        { ...PHONE_TOKEN, is_active: false, disabled_at: '2026-10-04T05:02:00.000Z' },
        { ...PHONE_TOKEN, id: 'token-2', user_id: 'user-2' },
      ],
    },
  ])('does not re-send a push after $how', async ({ tokens }) => {
    const maintenance = createPushMaintenanceSupabase({
      retryableDeliveries: [retryableDelivery({ receipt_error_code: 'MessageRateExceeded' })],
      tokens,
    });
    const tokensBefore = structuredClone(maintenance.tokenTable.rows);
    const fetcher = vi.fn<typeof fetch>(async () => expoResponse({ data: { status: 'ok', id: 'ticket-retry' } }));
    const now = new Date('2026-10-04T05:10:00.000Z');

    // The job hears about it once: this run closes it.
    await expect(hasMobilePushMaintenanceWork(maintenance.adminSupabase as never, { now })).resolves.toBe(true);
    const summary = await processMobilePushMaintenance(maintenance.adminSupabase as never, { fetcher, now });

    expect(sentBodies(fetcher)).toEqual([]);
    expect(summary).toMatchObject({
      retryableCount: 1,
      retriedCount: 0,
      retrySkippedCount: 1,
      resentCount: 0,
      retryFailedCount: 0,
    });
    expect(maintenance.tokenTable.rows).toEqual(tokensBefore);
    expect(maintenance.deliveries).toEqual([
      expect.objectContaining({
        send_status: 'error',
        receipt_status: 'stale',
        receipt_error_code: 'MessageRateExceeded',
        receipt_message: 'Not retried: the push token is no longer active for this account.',
        attempt_count: 1,
      }),
    ]);
    await expect(hasMobilePushMaintenanceWork(maintenance.adminSupabase as never, { now })).resolves.toBe(false);
  });

  // A delivery that was only passed over would wait on the ledger with its
  // attempts unspent. The account signing in again on that phone, a week later,
  // brings the same token row back to life, and the next run would deliver a
  // week-old alert.
  it('closes a delivery it will not send, so the token coming back does not send it late', async () => {
    const maintenance = createPushMaintenanceSupabase({
      retryableDeliveries: [retryableDelivery({ receipt_error_code: 'MessageRateExceeded' })],
      tokens: [{ ...PHONE_TOKEN, is_active: false, disabled_at: '2026-10-04T05:02:00.000Z' }],
    });
    const fetcher = vi.fn<typeof fetch>(async () => expoResponse({ data: { status: 'ok', id: 'ticket-retry' } }));

    await processMobilePushMaintenance(maintenance.adminSupabase as never, {
      fetcher,
      now: new Date('2026-10-04T05:10:00.000Z'),
    });
    Object.assign(maintenance.tokenTable.rows[0], { is_active: true, disabled_at: null });

    await expect(processMobilePushMaintenance(maintenance.adminSupabase as never, {
      fetcher,
      now: new Date('2026-10-11T05:10:00.000Z'),
    })).resolves.toMatchObject({ retryableCount: 0, retriedCount: 0 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  // token_id goes to null when a token row is deleted. The retry does not go by
  // it. The question is whether the account holds this token on a live row.
  it('closes a delivery whose token row is gone', async () => {
    const maintenance = createPushMaintenanceSupabase({
      retryableDeliveries: [retryableDelivery({ token_id: null })],
      tokens: [],
    });
    const fetcher = vi.fn<typeof fetch>(async () => expoResponse({ data: { status: 'ok', id: 'ticket-retry' } }));

    const summary = await processMobilePushMaintenance(maintenance.adminSupabase as never, {
      fetcher,
      now: new Date('2026-10-04T05:10:00.000Z'),
    });

    expect(fetcher).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ retryableCount: 1, retriedCount: 0, retrySkippedCount: 1 });
    expect(maintenance.deliveries).toEqual([
      expect.objectContaining({ receipt_status: 'stale', attempt_count: 1 }),
    ]);
  });

  it('re-sends a delivery with no token id when the account holds that token on a live row', async () => {
    const maintenance = createPushMaintenanceSupabase({
      retryableDeliveries: [retryableDelivery({ token_id: null })],
      tokens: [{ ...PHONE_TOKEN, id: 'token-9' }],
    });
    const fetcher = vi.fn<typeof fetch>(async () => expoResponse({ data: DEVICE_NOT_REGISTERED }));

    const summary = await processMobilePushMaintenance(maintenance.adminSupabase as never, {
      fetcher,
      now: new Date('2026-10-04T05:10:00.000Z'),
    });

    expect(sentBodies(fetcher)).toEqual([
      expect.objectContaining({ to: 'ExponentPushToken[phone]' }),
    ]);
    // The row it found live is the row it retires when Expo says the device is gone.
    expect(summary).toMatchObject({ retriedCount: 1, retryFailedCount: 1, retryDisabledTokenCount: 1 });
    expect(maintenance.tokenTable.rows).toEqual([
      { ...PHONE_TOKEN, id: 'token-9', is_active: false, disabled_at: expect.any(String) },
    ]);
  });

  it('sends nothing when it cannot read the token row', async () => {
    const maintenance = createPushMaintenanceSupabase({
      retryableDeliveries: [retryableDelivery()],
      tokens: [{ ...PHONE_TOKEN }],
      tokenReadError: { message: 'connection reset' },
    });
    const fetcher = vi.fn<typeof fetch>(async () => expoResponse({ data: { status: 'ok', id: 'ticket-retry' } }));

    const run = processMobilePushMaintenance(maintenance.adminSupabase as never, {
      fetcher,
      now: new Date('2026-10-04T05:10:00.000Z'),
    }).then(() => 'completed', (error: unknown) => error);

    expect(await run).toMatchObject({ name: 'MobileNotificationError', status: 500 });
    expect(fetcher).not.toHaveBeenCalled();
    // The delivery is left as it was, for the next run to ask again.
    expect(maintenance.deliveryUpdates).toEqual([]);
  });

  // Pausing push in the app patches the account's preferences and nothing
  // else: the token row stays live, so the check above lets the retry through.
  // The first send asked the preferences. The retry comes ten or twenty minutes
  // later and has to ask them again.
  it.each([
    {
      how: 'the account paused push alerts',
      switches: { push_enabled: false },
      notification: {},
      receiptMessage: 'Not retried: push alerts are paused for this account.',
    },
    {
      how: 'the account switched off generation alerts',
      switches: { generation_enabled: false },
      notification: {},
      receiptMessage: 'Not retried: generation alerts are switched off for this account.',
    },
    {
      how: 'the account switched off commerce alerts',
      switches: { commerce_enabled: false },
      notification: { type: 'credits_purchased', category: 'commerce' },
      receiptMessage: 'Not retried: commerce alerts are switched off for this account.',
    },
    {
      how: 'the account switched off social alerts',
      switches: { social_enabled: false },
      notification: { type: 'post_saved', category: 'social' },
      receiptMessage: 'Not retried: social alerts are switched off for this account.',
    },
  ])('does not re-send a push after $how', async ({ switches, notification, receiptMessage }) => {
    const maintenance = createPushMaintenanceSupabase({
      retryableDeliveries: [retryableDelivery({ receipt_error_code: 'MessageRateExceeded' })],
      tokens: [{ ...PHONE_TOKEN }],
      preferences: [{ ...ALERTS_ON, ...switches }],
      notification,
    });
    const fetcher = vi.fn<typeof fetch>(async () => expoResponse({ data: { status: 'ok', id: 'ticket-retry' } }));
    const now = new Date('2026-10-04T05:10:00.000Z');

    // The job hears about it once: this run closes it.
    await expect(hasMobilePushMaintenanceWork(maintenance.adminSupabase as never, { now })).resolves.toBe(true);
    const summary = await processMobilePushMaintenance(maintenance.adminSupabase as never, { fetcher, now });

    expect(sentBodies(fetcher)).toEqual([]);
    expect(summary).toMatchObject({
      retryableCount: 1,
      retriedCount: 0,
      retrySkippedCount: 1,
      resentCount: 0,
      retryFailedCount: 0,
    });
    // Closed where it stands, with the reason. Its attempt count still says one
    // request was made, and what Expo said about that one is kept.
    expect(maintenance.deliveryUpdates).toEqual([
      {
        id: 'delivery-1',
        values: {
          receipt_status: 'stale',
          receipt_checked_at: '2026-10-04T05:10:00.000Z',
          receipt_message: receiptMessage,
        },
      },
    ]);
    expect(maintenance.deliveries).toEqual([
      expect.objectContaining({
        send_status: 'error',
        receipt_error_code: 'MessageRateExceeded',
        attempt_count: 1,
      }),
    ]);
    // The phone keeps its token: the account paused alerts, it did not sign out.
    expect(maintenance.tokenTable.updates).toEqual([]);
    await expect(hasMobilePushMaintenanceWork(maintenance.adminSupabase as never, { now })).resolves.toBe(false);
  });

  it.each([
    {
      how: 'every switch is on',
      switches: {},
      notification: {},
    },
    {
      how: 'only other kinds of alert are switched off',
      switches: { commerce_enabled: false, social_enabled: false },
      notification: {},
    },
    {
      how: 'its kind of alert has no switch of its own',
      switches: { generation_enabled: false, commerce_enabled: false, social_enabled: false },
      notification: { category: 'system' },
    },
  ])('re-sends a push when $how', async ({ switches, notification }) => {
    const maintenance = createPushMaintenanceSupabase({
      retryableDeliveries: [retryableDelivery({ receipt_error_code: 'MessageRateExceeded' })],
      tokens: [{ ...PHONE_TOKEN }],
      preferences: [{ ...ALERTS_ON, ...switches }],
      notification,
    });
    const fetcher = vi.fn<typeof fetch>(async () => expoResponse({ data: { status: 'ok', id: 'ticket-retry' } }));

    const summary = await processMobilePushMaintenance(maintenance.adminSupabase as never, {
      fetcher,
      now: new Date('2026-10-04T05:10:00.000Z'),
    });

    expect(sentBodies(fetcher)).toEqual([
      expect.objectContaining({ to: 'ExponentPushToken[phone]', title: 'Render ready' }),
    ]);
    expect(summary).toMatchObject({ retriedCount: 1, retrySkippedCount: 0, resentCount: 1 });
    expect(maintenance.deliveries).toEqual([
      expect.objectContaining({ send_status: 'sent', receipt_status: 'pending', attempt_count: 2 }),
    ]);
  });

  // The first send makes the account's preferences row before it asks Expo, so
  // a delivery normally has one. Where it is gone, the job goes by the defaults
  // a new row would hold and leaves the table alone: a job that runs every ten
  // minutes is no place to make settings rows, and an insert that failed would
  // turn a read into a failed run.
  it('reads an account with no preferences row as the defaults, and makes no row', async () => {
    const maintenance = createPushMaintenanceSupabase({
      retryableDeliveries: [retryableDelivery()],
      tokens: [{ ...PHONE_TOKEN }],
      preferences: [],
    });
    const fetcher = vi.fn<typeof fetch>(async () => expoResponse({ data: { status: 'ok', id: 'ticket-retry' } }));

    const summary = await processMobilePushMaintenance(maintenance.adminSupabase as never, {
      fetcher,
      now: new Date('2026-10-04T05:10:00.000Z'),
    });

    expect(sentBodies(fetcher)).toEqual([
      expect.objectContaining({ to: 'ExponentPushToken[phone]' }),
    ]);
    expect(summary).toMatchObject({ retriedCount: 1, retrySkippedCount: 0, resentCount: 1 });
    // What it asked for was this account's row, and it wrote nothing.
    expect(maintenance.preferenceTable.reads).toEqual([[['user_id', 'user-1']]]);
    expect(maintenance.preferenceTable.writes).toEqual([]);
    expect(maintenance.preferenceTable.rows).toEqual([]);
  });

  it('goes by the preferences of the account each delivery belongs to', async () => {
    const maintenance = createPushMaintenanceSupabase({
      retryableDeliveries: [
        retryableDelivery(),
        retryableDelivery({
          id: 'delivery-2',
          notification_id: 'notification-2',
          user_id: 'user-2',
          token_id: 'token-2',
          expo_push_token: 'ExponentPushToken[other]',
        }),
      ],
      tokens: [
        { ...PHONE_TOKEN },
        { ...PHONE_TOKEN, id: 'token-2', user_id: 'user-2', expo_push_token: 'ExponentPushToken[other]' },
      ],
      preferences: [
        { ...ALERTS_ON, push_enabled: false },
        { ...ALERTS_ON, user_id: 'user-2' },
      ],
    });
    const fetcher = vi.fn<typeof fetch>(async () => expoResponse({ data: { status: 'ok', id: 'ticket-retry' } }));

    const summary = await processMobilePushMaintenance(maintenance.adminSupabase as never, {
      fetcher,
      now: new Date('2026-10-04T05:10:00.000Z'),
    });

    expect(sentBodies(fetcher)).toEqual([
      expect.objectContaining({ to: 'ExponentPushToken[other]' }),
    ]);
    expect(summary).toMatchObject({ retryableCount: 2, retriedCount: 1, retrySkippedCount: 1, resentCount: 1 });
    expect(maintenance.deliveries).toEqual([
      expect.objectContaining({ id: 'delivery-1', send_status: 'error', receipt_status: 'stale' }),
      expect.objectContaining({ id: 'delivery-2', send_status: 'sent', receipt_status: 'pending' }),
    ]);
  });

  // A delivery that was only passed over would wait on the ledger with its
  // attempts unspent. The account switching alerts back on brings it within
  // the job's reach again, and the next run would deliver an alert the account
  // had asked not to get.
  it('closes a delivery it will not send, so switching alerts back on does not send it late', async () => {
    const maintenance = createPushMaintenanceSupabase({
      retryableDeliveries: [retryableDelivery({ receipt_error_code: 'MessageRateExceeded' })],
      tokens: [{ ...PHONE_TOKEN }],
      preferences: [{ ...ALERTS_ON, push_enabled: false }],
    });
    const fetcher = vi.fn<typeof fetch>(async () => expoResponse({ data: { status: 'ok', id: 'ticket-retry' } }));

    await processMobilePushMaintenance(maintenance.adminSupabase as never, {
      fetcher,
      now: new Date('2026-10-04T05:10:00.000Z'),
    });
    Object.assign(maintenance.preferenceTable.rows[0], { push_enabled: true });

    await expect(processMobilePushMaintenance(maintenance.adminSupabase as never, {
      fetcher,
      now: new Date('2026-10-04T05:20:00.000Z'),
    })).resolves.toMatchObject({ retryableCount: 0, retriedCount: 0 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sends nothing when it cannot read the account's preferences", async () => {
    const maintenance = createPushMaintenanceSupabase({
      retryableDeliveries: [retryableDelivery()],
      tokens: [{ ...PHONE_TOKEN }],
      preferencesReadError: { message: 'connection reset' },
    });
    const fetcher = vi.fn<typeof fetch>(async () => expoResponse({ data: { status: 'ok', id: 'ticket-retry' } }));
    const now = new Date('2026-10-04T05:10:00.000Z');

    const run = processMobilePushMaintenance(maintenance.adminSupabase as never, { fetcher, now })
      .then(() => 'completed', (error: unknown) => error);

    expect(await run).toMatchObject({ name: 'MobileNotificationError', status: 500 });
    expect(fetcher).not.toHaveBeenCalled();
    // The delivery is left as it was, for the next run to ask again.
    expect(maintenance.deliveryUpdates).toEqual([]);
    await expect(hasMobilePushMaintenanceWork(maintenance.adminSupabase as never, { now })).resolves.toBe(true);
  });

  it.each(['accepted', 'refused', 'permanent', 'paused'] as const)('surfaces a failed retry write after %s without rewriting it as a provider error', async (outcome) => {
    const maintenance = createPushMaintenanceSupabase({
      retryableDeliveries: [retryableDelivery()],
      tokens: [{ ...PHONE_TOKEN }],
      preferences: [{ ...ALERTS_ON, push_enabled: outcome !== 'paused' }],
      deliveryWriteError: { message: 'Database unavailable' },
    });
    const fetcher = vi.fn<typeof fetch>(async () => outcome === 'refused'
      ? new Response('{}', { status: 400 })
      : expoResponse({ data: outcome === 'permanent'
        ? refusedTicket('MessageTooBig') : { status: 'ok', id: 'accepted-ticket' } }));
    await expect(processMobilePushMaintenance(maintenance.adminSupabase as never, { fetcher }))
      .rejects.toThrow(outcome === 'paused' ? 'Failed to close unsent push delivery.' : 'Failed to record push retry.');
    expect(maintenance.deliveryUpdates).toHaveLength(1);
    expect(maintenance.deliveries[0]).toMatchObject({ send_status: 'error', receipt_status: 'error', attempt_count: outcome === 'paused' ? 1 : 2, push_ticket_id: null });
    expect(fetcher).toHaveBeenCalledTimes(outcome === 'paused' ? 0 : 1);
    if (outcome === 'accepted') expect(maintenance.deliveryUpdates[0]?.values).toMatchObject({ ticket_id: 'accepted-ticket', status: 'sent' });
  });

  it.each(PERMANENT_EXPO_ERRORS)('closes a delivery whose retry Expo refuses with %s', async (code) => {
    const maintenance = createPushMaintenanceSupabase({
      retryableDeliveries: [retryableDelivery({ receipt_error_code: 'MessageRateExceeded' })],
      tokens: [{ ...PHONE_TOKEN }],
    });
    const fetcher = vi.fn<typeof fetch>(async () => expoResponse({ data: refusedTicket(code) }));

    for (const now of ['2026-10-04T05:10:00.000Z', '2026-10-04T05:20:00.000Z']) {
      await processMobilePushMaintenance(maintenance.adminSupabase as never, { fetcher, now: new Date(now) });
    }

    // Asked on the first run and not on the second.
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(maintenance.deliveries).toEqual([
      expect.objectContaining({
        send_status: 'error',
        receipt_status: 'stale',
        receipt_error_code: code,
        attempt_count: 2,
        last_attempt_at: expect.any(String),
      }),
    ]);
  });

  it.each(PASSING_EXPO_ERRORS)('keeps trying a delivery Expo refuses with $reason until its attempts run out', async ({ code }) => {
    const maintenance = createPushMaintenanceSupabase({
      retryableDeliveries: [retryableDelivery()],
      tokens: [{ ...PHONE_TOKEN }],
    });
    const fetcher = vi.fn<typeof fetch>(async () => expoResponse({ data: refusedTicket(code) }));

    await processMobilePushMaintenance(maintenance.adminSupabase as never, {
      fetcher,
      now: new Date('2026-10-04T05:10:00.000Z'),
    });
    expect(maintenance.deliveries).toEqual([
      expect.objectContaining({ receipt_status: 'error', receipt_error_code: code ?? null, attempt_count: 2 }),
    ]);
    await expect(hasMobilePushMaintenanceWork(maintenance.adminSupabase as never, {
      now: new Date('2026-10-04T05:20:00.000Z'),
    })).resolves.toBe(true);

    await processMobilePushMaintenance(maintenance.adminSupabase as never, {
      fetcher,
      now: new Date('2026-10-04T05:20:00.000Z'),
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(maintenance.deliveries).toEqual([
      expect.objectContaining({ receipt_status: 'error', attempt_count: 3 }),
    ]);
    await expect(hasMobilePushMaintenanceWork(maintenance.adminSupabase as never, {
      now: new Date('2026-10-04T05:30:00.000Z'),
    })).resolves.toBe(false);
  });

  // Expo turned the request itself down. Nothing about a second request would
  // differ, which is why a send is not tried twice for it within one run either.
  it('closes a delivery whose retry Expo turns down outright', async () => {
    const maintenance = createPushMaintenanceSupabase({
      retryableDeliveries: [retryableDelivery({ receipt_error_code: 'MessageRateExceeded' })],
      tokens: [{ ...PHONE_TOKEN }],
    });
    const fetcher = vi.fn<typeof fetch>(async () => expoResponse({
      errors: [{ message: 'The token belongs to another project.' }],
    }, 400));

    for (const now of ['2026-10-04T05:10:00.000Z', '2026-10-04T05:20:00.000Z']) {
      await processMobilePushMaintenance(maintenance.adminSupabase as never, { fetcher, now: new Date(now) });
    }

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(maintenance.deliveries).toEqual([
      expect.objectContaining({
        receipt_status: 'stale',
        provider_message: 'The token belongs to another project.',
        attempt_count: 2,
      }),
    ]);
  });

  // Each scheduled retry spends one durable attempt before its provider call.
  it('spends the remaining attempts across runs when Expo cannot be reached', async () => {
    const maintenance = createPushMaintenanceSupabase({
      retryableDeliveries: [retryableDelivery()],
      tokens: [{ ...PHONE_TOKEN }],
    });
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error('network down');
    });
    const now = new Date('2026-10-04T05:10:00.000Z');

    await expect(processMobilePushMaintenance(maintenance.adminSupabase as never, { fetcher, now })).resolves.toMatchObject({
      retriedCount: 1,
      retryFailedCount: 1,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(maintenance.deliveries[0]).toMatchObject({ attempt_count: 2 });
    await processMobilePushMaintenance(maintenance.adminSupabase as never, { fetcher, now });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(maintenance.deliveries).toEqual([
      expect.objectContaining({ receipt_status: 'error', provider_message: 'network down', attempt_count: 3 }),
    ]);
    await expect(hasMobilePushMaintenanceWork(maintenance.adminSupabase as never, { now })).resolves.toBe(false);
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
        receipt_status: 'stale',
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
        receipt_status: 'stale',
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
        receipt_status: 'stale',
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
        receipt_status: 'stale',
        provider_message: 'The token belongs to another project.',
        attempt_count: 1,
      }),
    ]]);
  });

  // The first gap, end to end. A push Expo refused at send was filed with one
  // attempt and no ticket, which is what the retry job selects, so each of the
  // next two runs sent it again. The token here stays live throughout, so only
  // the way the refusal is filed keeps the job from it.
  it.each(PERMANENT_EXPO_ERRORS)('asks Expo once about a push it refuses with %s', async (code) => {
    const sendFetch = vi.fn<typeof fetch>(async () => expoResponse({ data: [refusedTicket(code)] }));
    vi.stubGlobal('fetch', sendFetch);
    const fanOut = createPushFanOutSupabase([
      { id: 'token-1', expo_push_token: 'ExponentPushToken[phone]', platform: 'android' },
    ]);
    await unlockNotification(fanOut.adminSupabase);

    const maintenance = createPushMaintenanceSupabase({ tokens: [{ ...PHONE_TOKEN }] });
    maintenance.storeDeliveries(fanOut.deliveryInsertCalls.flat());
    const retryFetch = vi.fn<typeof fetch>(async () => expoResponse({ data: refusedTicket(code) }));
    const workAfterSend = await hasMobilePushMaintenanceWork(maintenance.adminSupabase as never, {
      now: new Date('2026-10-04T05:10:00.000Z'),
    });
    for (const now of ['2026-10-04T05:10:00.000Z', '2026-10-04T05:20:00.000Z']) {
      await processMobilePushMaintenance(maintenance.adminSupabase as never, {
        fetcher: retryFetch,
        now: new Date(now),
      });
    }

    expect(sendFetch).toHaveBeenCalledTimes(1);
    expect(retryFetch).toHaveBeenCalledTimes(0);
    expect(workAfterSend).toBe(false);
    // One request was made, and the ledger still says one.
    expect(maintenance.deliveries).toEqual([
      expect.objectContaining({
        send_status: 'error',
        receipt_status: 'stale',
        receipt_error_code: code,
        attempt_count: 1,
      }),
    ]);
  });

  it.each(PASSING_EXPO_ERRORS)('leaves a push Expo refuses with $reason for the retry job', async ({ code }) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => expoResponse({ data: [refusedTicket(code)] })));
    const fanOut = createPushFanOutSupabase([
      { id: 'token-1', expo_push_token: 'ExponentPushToken[phone]', platform: 'android' },
    ]);
    await unlockNotification(fanOut.adminSupabase);

    expect(fanOut.deliveryInsertCalls).toEqual([[
      expect.objectContaining({
        send_status: 'error',
        receipt_status: 'error',
        receipt_error_code: code ?? null,
        attempt_count: 1,
      }),
    ]]);

    const maintenance = createPushMaintenanceSupabase({ tokens: [{ ...PHONE_TOKEN }] });
    maintenance.storeDeliveries(fanOut.deliveryInsertCalls.flat());
    const retryFetch = vi.fn<typeof fetch>(async () => expoResponse({ data: { status: 'ok', id: 'ticket-retry' } }));
    const now = new Date('2026-10-04T05:10:00.000Z');

    await expect(hasMobilePushMaintenanceWork(maintenance.adminSupabase as never, { now })).resolves.toBe(true);
    await expect(processMobilePushMaintenance(maintenance.adminSupabase as never, {
      fetcher: retryFetch,
      now,
    })).resolves.toMatchObject({ retryableCount: 1, retriedCount: 1, resentCount: 1 });
    expect(maintenance.deliveries).toEqual([
      expect.objectContaining({
        push_ticket_id: 'ticket-retry',
        send_status: 'sent',
        receipt_status: 'pending',
        attempt_count: 2,
      }),
    ]);
  });

  // Expo turned the request itself down. The send path does not try such a
  // request twice, because nothing about a second one would differ. The retry
  // job used to, ten and twenty minutes later.
  it('does not retry later a request Expo turned down outright', async () => {
    const refusal = () => expoResponse({ errors: [{ message: 'The token belongs to another project.' }] }, 400);
    const sendFetch = vi.fn<typeof fetch>(async () => refusal());
    vi.stubGlobal('fetch', sendFetch);
    const fanOut = createPushFanOutSupabase([
      { id: 'token-1', expo_push_token: 'ExponentPushToken[phone]', platform: 'android' },
    ]);
    await unlockNotification(fanOut.adminSupabase);

    const maintenance = createPushMaintenanceSupabase({ tokens: [{ ...PHONE_TOKEN }] });
    maintenance.storeDeliveries(fanOut.deliveryInsertCalls.flat());
    const retryFetch = vi.fn<typeof fetch>(async () => refusal());
    for (const now of ['2026-10-04T05:10:00.000Z', '2026-10-04T05:20:00.000Z']) {
      await processMobilePushMaintenance(maintenance.adminSupabase as never, {
        fetcher: retryFetch,
        now: new Date(now),
      });
    }

    expect(sendFetch).toHaveBeenCalledTimes(1);
    expect(retryFetch).toHaveBeenCalledTimes(0);
    expect(maintenance.deliveries).toEqual([
      expect.objectContaining({ send_status: 'error', receipt_status: 'stale', attempt_count: 1 }),
    ]);
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
