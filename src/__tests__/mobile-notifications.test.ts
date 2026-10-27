import fs from 'node:fs';
import path from 'node:path';

import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createExpoPushService,
  createMobileNotificationHistory,
  withMobileNotificationHistory,
  type MobileNotificationHistory,
} from '@/__tests__/fixtures/mobile-notification-history';
import { createStoredRows } from '@/__tests__/fixtures/stored-rows';
import { setBackendLogSink, type BackendLogRecord } from '@/lib/backend-logger';
import {
  MobileNotificationError,
  NAMED_SAVE_PUSH_HOLD_MS,
  buildMobileNotificationDeepLink,
  createMobileNotification,
  creatorFollowedWords,
  hasMobilePushMaintenanceWork,
  hasPendingMobilePushReceipts,
  normalizeMobilePushTokenPayload,
  notifyCreatorFollowed,
  notifyCreatorPayoutResolved,
  notifyGenerationStatus,
  notifyMobilePurchasesRestored,
  notifyPostResourceUnlockCompleted,
  notifyPostSocialActivity,
  processMobilePushMaintenance,
  processPendingMobilePushReceipts,
  sendExpoPushNotification,
  sendExpoPushNotificationBatch,
  sendExpoPushNotificationWithRetry,
  toMobileNotificationRecord,
} from '@/lib/mobile-notifications';
import { EXTERNAL_API_REQUEST_TIMEOUT_MS } from '@/lib/provider-fetch';
import { siteConfig } from '@/lib/seo';


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
      if (name === 'scan_mobile_push_maintenance') {
        const due = new Date(String(args.p_now)).getTime() - 15 * 60 * 1000;
        const eligible = deliveries.filter(row => args.p_phase === 'recorded' ? row.retry_outcome != null
          : args.p_phase === 'receipts' ? row.receipt_status === 'pending' && Date.parse(String(row.sent_at)) <= due
            : row.send_status === 'error' && row.receipt_status === 'error' && row.push_ticket_id == null && row.retry_outcome == null && Number(row.attempt_count) < 3);
        return { data: eligible.slice(0, Number(args.p_limit)).map(row => ({ ...row })), error: null };
      }
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
 * `stored` is what the database keeps in place of the words it was given, as
 * a BEFORE INSERT trigger rewrites them.
 */
function createPushFanOutSupabase(
  tokens: PushTokenRow[],
  summaryError: { message: string } | null = null,
  stored: Partial<Record<'title' | 'body' | 'deep_link', string>> = {},
) {
  const deliveries: Record<string, unknown>[] = [];
  const rpcCalls: string[] = [];
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
    async rpc(name: string, args: {p_items: Array<{delivery_id:string;claim_id:string;outcome:Record<string,unknown>}>}) {
      rpcCalls.push(name);
      for (const item of args.p_items) {
        const row = deliveries.find(row => row.id === item.delivery_id && row.retry_claim_id === item.claim_id);
        if (!row) continue;
        if (name === 'record_initial_mobile_push_outcomes') { row.retry_outcome = item.outcome; continue; }
        expect(name).toBe('finish_initial_mobile_push_outcomes');
        const outcome = row.retry_outcome as Record<string, unknown>;
        if (outcome.error_code === 'DeviceNotRegistered') await tokenTable.update({is_active:false,disabled_at:new Date().toISOString()}).in('id',[String(row.token_id)]).eq('is_active',true).select();
        Object.assign(row, {
          send_status: outcome.status === 'sent' ? 'sent' : 'error',
          receipt_status: outcome.status === 'sent' ? 'pending' : outcome.status === 'refused' ? 'stale' : 'error',
          push_ticket_id: outcome.ticket_id ?? null,
          receipt_error_code: outcome.error_code ?? null,
          receipt_message: outcome.message ?? null,
          provider_message: outcome.message ?? null, provider_details:outcome.details ?? null,
          attempt_count: outcome.attempt_count, initial_attempt_reservation:false,
          retry_claim_id:null,retry_outcome:null,
        });
      }
      return {data:args.p_items.length,error:null};
    },
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
                        ...stored,
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
                return Promise.resolve({ error: summaryError });
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
            deliveries.push(...[values].flat().map(row => ({...row})));
            return { error: null };
          },
        };
      }

      throw new Error(`Unexpected table ${table}`);
    },
  };

  return {
    adminSupabase, deliveries, rpcCalls,
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
    title: 'Recipe unlocked',
    body: 'The prompt and files are ready.',
    deepLink: '/showcase/post-1',
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
    // The post page, which keeps a text or covered post off the For You reel.
    expect(buildMobileNotificationDeepLink({ kind: 'showcasePost', postId: 'post-1' }))
      .toBe('/showcase/post-1');
    // The post page at its recipe, for the buyer's "Recipe unlocked" alert.
    expect(buildMobileNotificationDeepLink({ kind: 'showcasePostRecipe', postId: 'post-1' }))
      .toBe('/showcase/post-1?page=details&section=resources');
    expect(buildMobileNotificationDeepLink({ kind: 'creatorProfile', username: 'athul' }))
      .toBe('/creators/athul');
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

  it('reads a payout alert back as the kind it was written as', () => {
    // An unknown type reads as a finished generation, which a payout is not.
    expect(['creator_payout_paid', 'creator_payout_rejected'].map((type) => (
      toMobileNotificationRecord({ id: 'notification-1', type, category: 'commerce' }).type
    ))).toEqual(['creator_payout_paid', 'creator_payout_rejected']);
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
    const scan = vi.fn(async () => ({ data: deliveryRows, error: null }));

    const adminSupabase = {
      rpc: scan,
      from(table: string) {
        if (table === 'mobile_push_deliveries') {
          return {
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
    expect(scan).toHaveBeenCalledWith('scan_mobile_push_maintenance', { p_phase: 'receipts', p_limit: 1000, p_now: '2026-05-26T12:00:00.000Z' });
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

  // notification_id goes to null when the alert is deleted: a named save's
  // alert goes with its save, and any alert with its account or post. The
  // delivery stays for its receipt. Sent again, it would push an alert that is
  // no longer there, naming a saver who took the save back.
  it('closes a delivery whose alert is gone, without sending it or asking whether it could', async () => {
    const maintenance = createPushMaintenanceSupabase({
      retryableDeliveries: [retryableDelivery({ notification_id: null, receipt_error_code: 'MessageRateExceeded' })],
      tokens: [{ ...PHONE_TOKEN }],
      notification: { type: 'post_saved', category: 'social', title: '@maya saved your post' },
    });
    const fetcher = vi.fn<typeof fetch>(async () => expoResponse({ data: { status: 'ok', id: 'ticket-retry' } }));
    const now = new Date('2026-10-04T05:10:00.000Z');

    // The job hears about it once: this run closes it.
    await expect(hasMobilePushMaintenanceWork(maintenance.adminSupabase as never, { now })).resolves.toBe(true);
    const summary = await processMobilePushMaintenance(maintenance.adminSupabase as never, { fetcher, now });

    expect(fetcher).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ retryableCount: 1, retriedCount: 0, resentCount: 0, retryFailedCount: 0 });
    // Closed where it stands, with the reason, and the attempt it made is kept.
    expect(maintenance.deliveryUpdates).toEqual([
      {
        id: 'delivery-1',
        values: {
          receipt_status: 'stale',
          receipt_checked_at: '2026-10-04T05:10:00.000Z',
          receipt_message: 'Notification no longer exists.',
        },
      },
    ]);
    expect(maintenance.deliveries).toEqual([
      expect.objectContaining({ send_status: 'error', receipt_status: 'stale', receipt_error_code: 'MessageRateExceeded', attempt_count: 1 }),
    ]);
    expect(maintenance.tokenTable.reads).toEqual([]);
    expect(maintenance.preferenceTable.reads).toEqual([]);
    await expect(hasMobilePushMaintenanceWork(maintenance.adminSupabase as never, { now })).resolves.toBe(false);
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

    expect(await run).toMatchObject({ name: 'MobilePushMaintenanceError', summary: { maintenanceFailureCount: 1, failedPhases: ['retries'] }, cause: { name: 'MobileNotificationError', status: 500 } });
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

    expect(await run).toMatchObject({ name: 'MobilePushMaintenanceError', summary: { maintenanceFailureCount: 1, failedPhases: ['retries'] }, cause: { name: 'MobileNotificationError', status: 500 } });
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

  it('logs a summary write failure while retaining the accepted delivery', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetcher = vi.fn(async () => expoResponse({ data: [{ status: 'ok', id: 'ticket-summary' }] }));
    vi.stubGlobal('fetch', fetcher);
    const fanOut = createPushFanOutSupabase([
      { id: 'token-1', expo_push_token: 'ExponentPushToken[summary]', platform: 'ios' },
    ], { message: 'Summary unavailable' });
    await expect(unlockNotification(fanOut.adminSupabase)).resolves.toMatchObject({ id: 'notification-1' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fanOut.deliveries).toEqual([expect.objectContaining({ send_status: 'sent', push_ticket_id: 'ticket-summary' })]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('mobile_push_summary_update_failed'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('notification-1'));
  });

  it('records delivery errors when the Expo send call throws before a receipt is created', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));

    const fanOut = createPushFanOutSupabase([{id:'token-1',expo_push_token:'ExponentPushToken[token123]',platform:'ios'}]);
    const {adminSupabase,notificationUpdates,deliveries:deliveryInserts} = fanOut;

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
        receipt_message: 'network down',
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
  it('sends every device on an account in one Expo request with batched durable writes', async () => {
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
      title: 'Recipe unlocked',
      body: 'The prompt and files are ready.',
      sound: 'default',
      channelId: 'default',
      priority: 'high',
      data: {
        notificationId: 'notification-1',
        type: 'post_resource_unlocked',
        category: 'commerce',
        deepLink: '/showcase/post-1',
      },
    };
    expect(sentBodies(fetchMock)).toEqual([[
      { to: 'ExponentPushToken[phone]', ...message },
      { to: 'ExponentPushToken[gone]', ...message },
      { to: 'ExponentPushToken[tablet]', ...message },
      { to: 'ExponentPushToken[devbuild]', ...message },
    ]]);

    expect(fanOut.deliveryInsertCalls).toHaveLength(1);
    expect(fanOut.deliveries).toEqual([
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

  // A follow or sale alert written across a block is stored without the name
  // (20261020072851, 20261020053858), and its push must say what was stored.
  it('pushes the words the database stored, not the words it was asked to write', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => expoResponse({ data: [{ status: 'ok', id: 'ticket-1' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const unnamed = creatorFollowedWords(null);
    const fanOut = createPushFanOutSupabase(
      [{ id: 'token-1', expo_push_token: 'ExponentPushToken[phone]', platform: 'android' }],
      null,
      { body: unnamed.body, deep_link: unnamed.deepLink },
    );

    await createMobileNotification({
      adminSupabase: fanOut.adminSupabase as never,
      userId: 'user-1',
      actorUserId: 'follower-1',
      type: 'creator_followed',
      category: 'social',
      ...creatorFollowedWords('maya'),
      objectType: 'profile',
      objectId: 'follower-1',
    });

    expect(sentBodies(fetchMock)).toEqual([[expect.objectContaining({
      title: 'New follower',
      body: 'Someone followed your creator profile.',
      data: expect.objectContaining({ type: 'creator_followed', deepLink: '/studio' }),
    })]]);
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
    expect([fanOut.deliveries]).toEqual([[
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
    // Every device's reservation is made before any provider call, in one
    // statement, so an alert gone meanwhile leaves none reserved; results are
    // recorded per request.
    expect(fanOut.deliveryInsertCalls.map((rows) => rows.length)).toEqual([101]);
    // Tickets are matched to tokens by position, on both sides of the boundary.
    expect(fanOut.deliveries[99]).toMatchObject({
      token_id: 'token-99',
      push_ticket_id: 'ticket-for-ExponentPushToken[device99]',
    });
    expect(fanOut.deliveries[100]).toMatchObject({
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
    expect(fanOut.deliveries).toEqual([
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
    expect([fanOut.deliveries]).toEqual([[
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
    maintenance.storeDeliveries(fanOut.deliveries);
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

    expect([fanOut.deliveries]).toEqual([[
      expect.objectContaining({
        send_status: 'error',
        receipt_status: 'error',
        receipt_error_code: code ?? null,
        attempt_count: 1,
      }),
    ]]);

    const maintenance = createPushMaintenanceSupabase({ tokens: [{ ...PHONE_TOKEN }] });
    maintenance.storeDeliveries(fanOut.deliveries);
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
    maintenance.storeDeliveries(fanOut.deliveries);
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
            deep_link: '/showcase/post-1',
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
      deepLink: '/showcase/post-1',
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
    const scan = vi.fn(async () => ({ data: deliveryRows, error: null }));

    const adminSupabase = {
      rpc: scan,
      from(table: string) {
        if (table === 'mobile_push_deliveries') {
          return {
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

describe('a failed generation notification', () => {
  const FAILED_BODY = `Open ${siteConfig.name} to try again or adjust the prompt.`;
  const creation = { id: 'gen-1', user_id: 'user-1', category: 'video', model: 'kling-3.0/video', template_run_id: null };

  /** The notification the real notifier writes, over a settled `generations` row it may read. */
  async function notified(
    row: Record<string, unknown>,
    subject: Parameters<typeof notifyGenerationStatus>[1] = creation,
    status: 'succeeded' | 'failed' = 'failed',
  ) {
    const stored = createStoredRows({ generations: [{ id: 'gen-1', template_run_id: null, ...row }] });
    const history = createMobileNotificationHistory();
    await notifyGenerationStatus(withMobileNotificationHistory(stored.client, history), subject, status);
    expect(history.sent).toHaveLength(1);
    return { notification: history.sent[0], reads: stored.reads };
  }

  it.each([
    ['its credits were returned', { cost: 40, refunded: true }, `${FAILED_BODY} Your 40 credits were returned.`],
    ['its one credit was returned', { cost: 1, refunded: true }, `${FAILED_BODY} Your 1 credit was returned.`],
    ['nothing was returned', { cost: 40, refunded: false }, FAILED_BODY],
    ['the run cost nothing', { cost: 0, refunded: true }, FAILED_BODY],
    ['the row predates the refund flag', { cost: 40, refunded: null }, FAILED_BODY],
  ])('says so when %s', async (_case, row, body) => {
    const { notification, reads } = await notified(row);

    expect(notification).toMatchObject({ type: 'generation_failed', title: 'Your video failed', body });
    // Read after the settlement: a row the caller read before it still says `refunded: false`.
    expect(reads).toEqual([{ table: 'generations', columns: ['cost', 'refunded'] }]);
  });

  it('looks the refund up after the run, for a caller that did not say which it was', async () => {
    const { notification, reads } = await notified(
      { cost: 40, refunded: true },
      { id: 'gen-1', user_id: 'user-1', category: 'video', model: 'kling-3.0/video' },
    );

    expect(notification.body).toBe(`${FAILED_BODY} Your 40 credits were returned.`);
    expect(reads).toEqual([
      { table: 'generations', columns: ['template_run_id'] },
      { table: 'generations', columns: ['cost', 'refunded'] },
    ]);
  });

  it('reads no refund for a finished creation or a template step', async () => {
    const finished = await notified({ cost: 40, refunded: false }, creation, 'succeeded');
    expect(finished.notification.body).toBe('Open it in your history.');
    expect(finished.reads).toEqual([]);

    // A step's failure leads to its run, where the step is retried.
    const step = await notified({ cost: 40, refunded: true }, { ...creation, template_run_id: 'run-1' });
    expect(step.notification.body).toBe('Open your template run to retry this step.');
    expect(step.reads).toEqual([]);
  });

  it('still sends the failure, without the credits line, when the refund cannot be read', async () => {
    const history = createMobileNotificationHistory();
    const unreadable = {
      from: () => ({
        select: () => ({
          eq: () => ({ single: async () => ({ data: null, error: { message: 'permission denied' } }) }),
        }),
      }),
    } as unknown as SupabaseClient;
    const logged: BackendLogRecord[] = [];
    const restoreLogSink = setBackendLogSink((record) => { logged.push(record); });
    try {
      await expect(notifyGenerationStatus(withMobileNotificationHistory(unreadable, history), creation, 'failed'))
        .resolves.not.toBeNull();
    } finally {
      restoreLogSink();
    }

    expect(logged.map((record) => record.msg)).toEqual(['generation_notification_refund_unread']);
    expect(history.sent).toEqual([expect.objectContaining({ title: 'Your video failed', body: FAILED_BODY })]);
  });
});

describe('what each alert opens and says', () => {
  // The real producers, against notification history that keeps every row
  // they write. Anything else they reached for would throw here.
  function writtenTo(history: MobileNotificationHistory) {
    const elsewhere = (name: string) => {
      throw new Error(`Unexpected call: ${name}`);
    };
    return withMobileNotificationHistory({
      from: elsewhere,
      rpc: async (name: string) => elsewhere(name),
    } as unknown as SupabaseClient, history);
  }

  const CREATOR_PHONE = 'ExponentPushToken[creator-phone]';

  /**
   * creator-1's posts and the readers who save them: maya, lee and ana told
   * on record by handles they chose; reader-4 told, by the placeholder handle
   * every account starts with; reader-0 never told.
   */
  const SAVING = {
    posts: { 'post-1': 'creator-1', 'post-2': 'creator-1' },
    savers: {
      'reader-1': { username: 'maya', told: true },
      'reader-2': { username: 'lee', told: true },
      'reader-3': { username: 'ana', told: true },
      'reader-4': { username: 'creator-0a1b2c3d', told: true },
      'reader-0': { username: 'reader-zero', told: false },
    },
  };

  /** History in which creator-1's phone takes pushes, with Expo stood in for. */
  function withCreatorPhone() {
    const expo = createExpoPushService();
    vi.stubGlobal('fetch', expo.fetch);
    return { history: createMobileNotificationHistory({ ...SAVING, pushTo: { 'creator-1': [CREATOR_PHONE] } }), expo };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens the post page from a saved, shared or recipe-unlocked alert, and Your Sales from a sale', async () => {
    // A finished remix's alert is pinned in completed-remix-notification.test.ts.
    const history = createMobileNotificationHistory({ profiles: {} });
    const client = writtenTo(history);

    await notifyPostSocialActivity(client, { type: 'post_saved', recipientUserId: 'creator-1', actorUserId: 'reader-1', postId: 'post-1' });
    await notifyPostSocialActivity(client, { type: 'post_shared', recipientUserId: 'creator-1', actorUserId: 'reader-1', postId: 'post-1' });
    await notifyPostResourceUnlockCompleted(client, {
      buyerUserId: 'reader-1',
      ownerUserId: 'creator-1',
      postId: 'post-1',
      bundleId: 'bundle-1',
    });

    expect(history.sent.map((row) => [row.type, row.user_id, row.deep_link])).toEqual([
      ['post_saved', 'creator-1', '/showcase/post-1'],
      ['post_shared', 'creator-1', '/showcase/post-1'],
      ['post_resource_unlocked', 'reader-1', '/showcase/post-1?page=details&section=resources'],
      // The seller's is a sale: it opens where the listing and the payout balance are.
      ['post_resource_unlocked', 'creator-1', buildMobileNotificationDeepLink({ kind: 'sellerDashboard' })],
    ]);
  });

  it('tells a seller of a sale and of a free open as commerce, in words that tell the two apart', async () => {
    const history = createMobileNotificationHistory({ profiles: {} });
    const client = writtenTo(history);
    const unlock = { buyerUserId: 'reader-1', ownerUserId: 'creator-1', postId: 'post-1', bundleId: 'bundle-1' };

    await notifyPostResourceUnlockCompleted(client, unlock);
    await notifyPostResourceUnlockCompleted(client, { ...unlock, buyerUserId: 'reader-2', free: true });

    // Commerce follows the commerce switch and goes out at high priority; as a
    // social alert the sale went out at default priority and the social switch
    // silenced it.
    const sellerAlerts = history.sent.filter((row) => row.user_id === 'creator-1');
    expect(sellerAlerts.map(({ actor_user_id, category, title, body, deep_link, dedupe_key }) => (
      { actor_user_id, category, title, body, deep_link, dedupe_key }
    ))).toEqual([
      {
        actor_user_id: 'reader-1',
        category: 'commerce',
        title: 'You made a sale',
        body: 'A creator bought your recipe.',
        deep_link: '/seller-dashboard',
        dedupe_key: 'post-resource-sale:post-1:reader-1',
      },
      {
        actor_user_id: 'reader-2',
        category: 'commerce',
        title: 'Someone got your free recipe',
        body: 'A creator got the free recipe on your post.',
        deep_link: '/seller-dashboard',
        dedupe_key: 'post-resource-sale:post-1:reader-2',
      },
    ]);
    // The buyer's alert is the same either way.
    expect(history.sent.filter((row) => row.user_id !== 'creator-1').map((row) => [row.title, row.deep_link])).toEqual([
      ['Recipe unlocked', '/showcase/post-1?page=details&section=resources'],
      ['Recipe unlocked', '/showcase/post-1?page=details&section=resources'],
    ]);
  });

  it('names the buyer to the seller by their handle, in a sale and in a free open', async () => {
    // Recent sales lists paid buyers by handle already. Any handle, the
    // creator-xxxxxxxx one every account starts with included, as a follow
    // alert names a follower.
    const history = createMobileNotificationHistory({ profiles: { 'reader-1': 'Maya', 'reader-2': 'creator-0a1b2c3d' } });
    const client = writtenTo(history);
    const unlock = { buyerUserId: 'reader-1', ownerUserId: 'creator-1', postId: 'post-1', bundleId: 'bundle-1' };

    await notifyPostResourceUnlockCompleted(client, unlock);
    await notifyPostResourceUnlockCompleted(client, { ...unlock, buyerUserId: 'reader-2', free: true });

    const sellerAlerts = history.sent.filter((row) => row.user_id === 'creator-1');
    expect(sellerAlerts.map(({ actor_user_id, category, title, body, deep_link, dedupe_key }) => (
      { actor_user_id, category, title, body, deep_link, dedupe_key }
    ))).toEqual([
      {
        actor_user_id: 'reader-1',
        category: 'commerce',
        title: 'You made a sale',
        body: '@maya bought your recipe.',
        deep_link: '/seller-dashboard',
        dedupe_key: 'post-resource-sale:post-1:reader-1',
      },
      {
        actor_user_id: 'reader-2',
        category: 'commerce',
        title: '@creator-0a1b2c3d got your free recipe',
        body: 'They have the prompt and files now.',
        deep_link: '/seller-dashboard',
        dedupe_key: 'post-resource-sale:post-1:reader-2',
      },
    ]);
    // The buyer's own alert names no one.
    expect(history.sent.filter((row) => row.user_id !== 'creator-1').map((row) => [row.title, row.body])).toEqual([
      ['Recipe unlocked', 'The prompt and files are ready.'],
      ['Recipe unlocked', 'The prompt and files are ready.'],
    ]);
  });

  it('tells the seller without a name when the buyer has no handle, or it cannot be read', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const unlock = { ownerUserId: 'creator-1', postId: 'post-1', bundleId: 'bundle-1' };
    const unnamed = [
      ['You made a sale', 'A creator bought your recipe.'],
      ['Someone got your free recipe', 'A creator got the free recipe on your post.'],
    ];

    // reader-1 has no handle; reader-2 has no profile row.
    const history = createMobileNotificationHistory({ profiles: { 'reader-1': null } });
    const client = writtenTo(history);
    await notifyPostResourceUnlockCompleted(client, { ...unlock, buyerUserId: 'reader-1' });
    await notifyPostResourceUnlockCompleted(client, { ...unlock, buyerUserId: 'reader-2', free: true });
    expect(history.sent.filter((row) => row.user_id === 'creator-1').map((row) => [row.title, row.body])).toEqual(unnamed);
    expect(errorSpy).not.toHaveBeenCalled();

    // The profile read fails: that costs the name, never the alert.
    const unreadable = createMobileNotificationHistory();
    const unreadableClient = withMobileNotificationHistory({
      from: (table: string) => {
        if (table !== 'profiles') throw new Error(`Unexpected call: ${table}`);
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'read failed' } }) }),
          }),
        };
      },
      rpc: async (name: string) => {
        throw new Error(`Unexpected call: ${name}`);
      },
    } as unknown as SupabaseClient, unreadable);
    await notifyPostResourceUnlockCompleted(unreadableClient, { ...unlock, buyerUserId: 'reader-3' });
    await notifyPostResourceUnlockCompleted(unreadableClient, { ...unlock, buyerUserId: 'reader-4', free: true });
    expect(unreadable.sent.filter((row) => row.user_id === 'creator-1').map((row) => [row.title, row.body])).toEqual(unnamed);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('failed_to_load_alert_profile'));
    errorSpy.mockRestore();
  });

  it('tells a seller their payout was sent, or not sent and why, and opens Your Sales', async () => {
    const history = createMobileNotificationHistory();
    const client = writtenTo(history);
    const payout = { userId: 'creator-1', amountUsd: '$150.00' };

    // A paid request's note is the bank reference: it stays off the lock screen.
    await notifyCreatorPayoutResolved(client, { ...payout, requestId: 'request-1', status: 'paid', reason: 'UTR 4471' });
    await notifyCreatorPayoutResolved(client, {
      ...payout,
      requestId: 'request-2',
      status: 'rejected',
      reason: ' The UPI id did not match the account name ',
    });
    await notifyCreatorPayoutResolved(client, {
      ...payout,
      requestId: 'request-3',
      status: 'rejected',
      reason: 'Payouts to this bank are paused (until Monday).',
    });
    await notifyCreatorPayoutResolved(client, { ...payout, requestId: 'request-4', status: 'rejected', reason: null });

    expect(history.sent.map(({ user_id, type, category, title, body, deep_link, object_type, object_id, dedupe_key }) => (
      { user_id, type, category, title, body, deep_link, object_type, object_id, dedupe_key }
    ))).toEqual([
      {
        user_id: 'creator-1',
        type: 'creator_payout_paid',
        category: 'commerce',
        title: 'Payout sent',
        body: 'We sent $150.00 to your payout account.',
        deep_link: '/seller-dashboard',
        object_type: 'creator_payout_request',
        object_id: 'request-1',
        dedupe_key: 'creator-payout:request-1:paid',
      },
      expect.objectContaining({
        type: 'creator_payout_rejected',
        category: 'commerce',
        title: 'Payout not sent',
        body: 'The UPI id did not match the account name. $150.00 is back in your payout balance.',
        deep_link: '/seller-dashboard',
        object_id: 'request-2',
        dedupe_key: 'creator-payout:request-2:rejected',
      }),
      expect.objectContaining({
        body: 'Payouts to this bank are paused (until Monday). $150.00 is back in your payout balance.',
      }),
      expect.objectContaining({ body: '$150.00 is back in your payout balance.' }),
    ]);
  });

  it('words the seller alerts for both clients', async () => {
    // The web's Alerts prints these as written, beside the app. reader-1 and
    // reader-2 are named; reader-3 and reader-4 have no handle.
    const history = createMobileNotificationHistory({ profiles: { 'reader-1': 'maya', 'reader-2': 'lee' } });
    const client = writtenTo(history);
    const unlock = { buyerUserId: 'reader-1', ownerUserId: 'creator-1', postId: 'post-1', bundleId: 'bundle-1' };

    await notifyPostResourceUnlockCompleted(client, unlock);
    await notifyPostResourceUnlockCompleted(client, { ...unlock, buyerUserId: 'reader-2', free: true });
    await notifyPostResourceUnlockCompleted(client, { ...unlock, buyerUserId: 'reader-3' });
    await notifyPostResourceUnlockCompleted(client, { ...unlock, buyerUserId: 'reader-4', free: true });
    await notifyCreatorPayoutResolved(client, { userId: 'creator-1', requestId: 'request-1', status: 'paid', amountUsd: '$150.00', reason: null });
    await notifyCreatorPayoutResolved(client, { userId: 'creator-1', requestId: 'request-2', status: 'rejected', amountUsd: '$150.00', reason: 'Wrong account' });

    const words = history.sent
      .filter((row) => row.user_id === 'creator-1')
      .map((row) => `${row.title} ${row.body}`)
      .join(' ');
    expect(words).not.toMatch(/\bapp\b|mobile|\bweb\b|Your Sales|dashboard/i);
  });

  it("opens the follower's page from a New follower alert, and stays on Alerts with no handle to open", async () => {
    const history = createMobileNotificationHistory();
    const client = writtenTo(history);

    await notifyCreatorFollowed(client, { followerUserId: 'follower-1', followingUserId: 'creator-1', followerUsername: 'athul' });
    // An unclaimed handle is a real page on both clients, so it is opened like any other.
    await notifyCreatorFollowed(client, { followerUserId: 'follower-2', followingUserId: 'creator-1', followerUsername: 'creator-1a2b3c4d' });
    await notifyCreatorFollowed(client, { followerUserId: 'follower-3', followingUserId: 'creator-1', followerUsername: null });

    expect(history.sent.map((row) => [row.body, row.deep_link])).toEqual([
      ['@athul followed you.', '/creators/athul'],
      ['@creator-1a2b3c4d followed you.', '/creators/creator-1a2b3c4d'],
      ['Someone followed your creator profile.', '/studio'],
    ]);
  });

  it('names a saver only where the alert is written says so, in an alert of their own, and keeps no one on the anonymous ones', async () => {
    const history = createMobileNotificationHistory(SAVING);
    const client = writtenTo(history);
    const post = { recipientUserId: 'creator-1', postId: 'post-1', pushHoldMs: 0 };
    for (const saver of ['reader-1', 'reader-0', 'reader-4']) history.recordSave(saver, 'post-1', true);

    await notifyPostSocialActivity(client, { ...post, type: 'post_saved', actorUserId: 'reader-1', nameSaver: true });
    // Never told on record: "Someone", whatever the request said.
    await notifyPostSocialActivity(client, { ...post, type: 'post_saved', actorUserId: 'reader-0', nameSaver: true });
    // Told, by the placeholder handle every account starts with: "Someone".
    await notifyPostSocialActivity(client, { ...post, type: 'post_saved', actorUserId: 'reader-4', nameSaver: true });
    await notifyPostSocialActivity(client, { ...post, type: 'post_shared', actorUserId: 'reader-1', nameSaver: true });

    expect(history.sent.map((row) => [
      row.title,
      row.deep_link,
      row.dedupe_key ?? null,
      typeof row.aggregation_key === 'string' ? 'grouped' : 'its own',
      row.actor_user_id ?? null,
    ])).toEqual([
      ['@maya saved your post', '/showcase/post-1', 'post-save:reader-1:post-1', 'its own', 'reader-1'],
      // "Someone" stores nobody: nothing read from the row can name them.
      ['Someone saved your post', '/showcase/post-1', null, 'grouped', null],
      ['Someone shared your post', '/showcase/post-1', null, 'grouped', null],
    ]);
    expect(history.eventCounts()).toEqual([1, 2, 1]);
  });

  it('tells nobody of a save or share of their own post, though the anonymous alert keeps no actor to check', async () => {
    const history = createMobileNotificationHistory(SAVING);
    const client = writtenTo(history);
    history.recordSave('creator-1', 'post-1', true);

    for (const type of ['post_saved', 'post_shared'] as const) {
      await expect(notifyPostSocialActivity(client, {
        type, recipientUserId: 'creator-1', actorUserId: 'creator-1', postId: 'post-1', nameSaver: true, pushHoldMs: 0,
      })).resolves.toBeNull();
    }
    expect(history.sent).toEqual([]);
  });

  it("pushes a post's saves once a quarter-hour, named or not; the rest wait in Alerts", async () => {
    // Grouped saves pushed at most once a post per quarter-hour; naming some
    // savers must not turn a busy post into a push per saver, nor give it a
    // second push for its anonymous saves.
    const { history } = withCreatorPhone();
    const client = writtenTo(history);

    for (const [actorUserId, postId] of [
      ['reader-0', 'post-1'],
      ['reader-1', 'post-1'],
      ['reader-2', 'post-1'],
      ['reader-3', 'post-2'],
    ] as const) {
      history.recordSave(actorUserId, postId, true);
      await notifyPostSocialActivity(client, {
        type: 'post_saved', recipientUserId: 'creator-1', postId, actorUserId, nameSaver: actorUserId !== 'reader-0', pushHoldMs: 0,
      });
    }

    expect(history.sent.map((row) => row.title)).toEqual([
      'Someone saved your post',
      '@maya saved your post',
      '@lee saved your post',
      '@ana saved your post',
    ]);
    expect(history.pushClaims).toEqual([
      { key: 'creator-1:post-1', allowed: true },
      { key: 'creator-1:post-1', allowed: false },
      { key: 'creator-1:post-1', allowed: false },
      { key: 'creator-1:post-2', allowed: true },
    ]);
    // A push refused its slot gives its reservation back: only two were made and kept.
    expect(history.pushed.map((push) => push.title)).toEqual(['Someone saved your post', '@ana saved your post']);
  });

  it("pushes a grouped save once, at its group's first event: a later one adds to the group and claims no push slot", async () => {
    const { history, expo } = withCreatorPhone();
    const client = writtenTo(history);

    for (const actorUserId of ['reader-0', 'reader-9']) {
      await notifyPostSocialActivity(client, { type: 'post_saved', recipientUserId: 'creator-1', postId: 'post-1', actorUserId });
    }

    // One row holding both saves.
    expect(history.sent.map((row) => row.title)).toEqual(['Someone saved your post']);
    expect(history.eventCounts()).toEqual([2]);
    expect(history.pushClaims).toEqual([{ key: 'creator-1:post-1', allowed: true }]);
    expect(history.preferenceReads).toEqual(['creator-1']);
    expect(history.pushed).toEqual([{ user_id: 'creator-1', title: 'Someone saved your post', expo_push_token: CREATOR_PHONE }]);
    expect(expo.requests).toHaveLength(1);
  });

  it('spends no push on a named save whose alert already stands', async () => {
    const { history } = withCreatorPhone();
    const client = writtenTo(history);
    const saved = { type: 'post_saved' as const, recipientUserId: 'creator-1', postId: 'post-1', nameSaver: true, pushHoldMs: 0 };
    history.recordSave('reader-1', 'post-1', true);

    await expect(notifyPostSocialActivity(client, { ...saved, actorUserId: 'reader-1' }))
      .resolves.toMatchObject({ title: '@maya saved your post' });
    // The function writes the save's alert once, and answers "not written", with no row, after that.
    await expect(notifyPostSocialActivity(client, { ...saved, actorUserId: 'reader-1' }))
      .resolves.toBeNull();

    expect(history.sent).toHaveLength(1);
    expect(history.pushClaims).toEqual([{ key: 'creator-1:post-1', allowed: true }]);
    expect(history.preferenceReads).toEqual(['creator-1']);
    expect(history.pushed).toHaveLength(1);
  });

  it.each([
    // The unsave was answered, and its save gone, before the save's alert was written.
    { when: 'its save was taken back first', setUp: (history: MobileNotificationHistory) => history.recordSave('reader-1', 'post-1', false) },
    { when: 'the two accounts block each other', setUp: (history: MobileNotificationHistory) => history.recordBlock('creator-1', 'reader-1') },
  ])('writes no named alert, nor a "Someone" in its place, and spends no push, when $when', async ({ setUp }) => {
    const { history } = withCreatorPhone();
    const client = writtenTo(history);
    history.recordSave('reader-1', 'post-1', true);
    setUp(history);

    await expect(notifyPostSocialActivity(client, {
      type: 'post_saved', recipientUserId: 'creator-1', postId: 'post-1', actorUserId: 'reader-1', nameSaver: true, pushHoldMs: 0,
    })).resolves.toBeNull();

    expect(history.sent).toEqual([]);
    expect(history.preferenceReads).toEqual([]);
    expect(history.pushClaims).toEqual([]);

    // Another saver's alert of the same post is written and pushed as ever.
    history.recordSave('reader-2', 'post-1', true);
    await notifyPostSocialActivity(client, {
      type: 'post_saved', recipientUserId: 'creator-1', postId: 'post-1', actorUserId: 'reader-2', nameSaver: true, pushHoldMs: 0,
    });
    expect(history.sent.map((row) => row.title)).toEqual(['@lee saved your post']);
    expect(history.pushed.map((push) => push.title)).toEqual(['@lee saved your post']);
  });

  it('writes a named alert anew when a save taken back, its alert with it, is made again', async () => {
    const { history } = withCreatorPhone();
    const client = writtenTo(history);
    const saved = {
      type: 'post_saved' as const, recipientUserId: 'creator-1', postId: 'post-1', actorUserId: 'reader-1', nameSaver: true, pushHoldMs: 0,
    };
    history.recordSave('reader-1', 'post-1', true);

    await notifyPostSocialActivity(client, saved);
    // The unsave deletes the save, and the alert that announced it goes with it.
    history.recordSave('reader-1', 'post-1', false);
    expect(history.standing()).toEqual([]);
    history.recordSave('reader-1', 'post-1', true);
    await expect(notifyPostSocialActivity(client, saved)).resolves.toMatchObject({ title: '@maya saved your post' });

    expect([...history.removedRows]).toEqual([0]);
    expect(history.standing()).toEqual([
      expect.objectContaining({ title: '@maya saved your post', dedupe_key: 'post-save:reader-1:post-1' }),
    ]);
    // Written anew, it waits in Alerts: the phone heard about this post's saves this quarter-hour.
    expect(history.pushClaims).toEqual([
      { key: 'creator-1:post-1', allowed: true },
      { key: 'creator-1:post-1', allowed: false },
    ]);
    expect(history.pushed).toHaveLength(1);
  });

  // A post's push slot is spent only by a push that goes out. Spent for a
  // creator who would not hear it, it kept the next save of that post, the
  // first their phone could take, from pushing for the rest of the quarter-hour.
  it.each([
    { kind: 'push switched off', devices: undefined },
    { kind: 'push on and no live device', devices: [] as string[] },
  ])('asks for no push slot for a save, named or grouped, to a creator with $kind', async ({ devices }) => {
    const expo = createExpoPushService();
    vi.stubGlobal('fetch', expo.fetch);
    const pushTo: Record<string, string[]> = devices ? { 'creator-1': devices } : {};
    const history = createMobileNotificationHistory({ ...SAVING, pushTo });
    const client = writtenTo(history);
    for (const saver of ['reader-0', 'reader-1', 'reader-2']) history.recordSave(saver, 'post-1', true);

    await notifyPostSocialActivity(client, { type: 'post_saved', recipientUserId: 'creator-1', postId: 'post-1', actorUserId: 'reader-0' });
    await notifyPostSocialActivity(client, {
      type: 'post_saved', recipientUserId: 'creator-1', postId: 'post-1', actorUserId: 'reader-1', nameSaver: true, pushHoldMs: 0,
    });

    // Both were written anew and went on to decide whether to push; the
    // creator's devices are read only when push is on.
    expect(history.sent.map((row) => row.title)).toEqual(['Someone saved your post', '@maya saved your post']);
    expect(history.preferenceReads).toEqual(['creator-1', 'creator-1']);
    expect(history.tokenReads).toEqual(devices ? ['creator-1', 'creator-1'] : []);
    expect(history.pushClaims).toEqual([]);
    expect(history.pushed).toEqual([]);
    expect(expo.requests).toEqual([]);

    // The phone can take pushes now: the next save of that post still has the slot.
    pushTo['creator-1'] = [CREATOR_PHONE];
    await notifyPostSocialActivity(client, {
      type: 'post_saved', recipientUserId: 'creator-1', postId: 'post-1', actorUserId: 'reader-2', nameSaver: true, pushHoldMs: 0,
    });
    expect(history.pushClaims).toEqual([{ key: 'creator-1:post-1', allowed: true }]);
    expect(history.pushed.map((push) => push.title)).toEqual(['@lee saved your post']);
  });

  // Review 4 finding #3, the owner's choice of 2026-10-20: a named push waits,
  // and goes only if the save still stands then.
  describe('the hold before a named push', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it(`is ${NAMED_SAVE_PUSH_HOLD_MS / 1000} seconds by default, with the alert in Alerts from the start`, async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { history, expo } = withCreatorPhone();
      const client = writtenTo(history);
      history.recordSave('reader-1', 'post-1', true);

      const notified = notifyPostSocialActivity(client, {
        type: 'post_saved', recipientUserId: 'creator-1', postId: 'post-1', actorUserId: 'reader-1', nameSaver: true,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(history.standing().map((row) => row.title)).toEqual(['@maya saved your post']);
      expect(history.preferenceReads).toEqual([]);

      await vi.advanceTimersByTimeAsync(NAMED_SAVE_PUSH_HOLD_MS - 1);
      expect(expo.requests).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await expect(notified).resolves.toMatchObject({ title: '@maya saved your post' });
      expect(history.pushed.map((push) => push.title)).toEqual(['@maya saved your post']);
      expect(expo.requests).toHaveLength(1);
    });

    it.each([
      { what: 'an unsave', takeBack: (history: MobileNotificationHistory) => history.recordSave('reader-1', 'post-1', false) },
      { what: 'a block', takeBack: (history: MobileNotificationHistory) => history.recordBlock('reader-1', 'creator-1') },
    ])('sends nothing, and spends no slot, when $what takes the save back during it', async ({ takeBack }) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { history, expo } = withCreatorPhone();
      const client = writtenTo(history);
      history.recordSave('reader-1', 'post-1', true);
      const logged: BackendLogRecord[] = [];
      const restoreLogSink = setBackendLogSink((record) => { logged.push(record); });

      try {
        const notified = notifyPostSocialActivity(client, {
          type: 'post_saved', recipientUserId: 'creator-1', postId: 'post-1', actorUserId: 'reader-1', nameSaver: true,
        });
        await vi.advanceTimersByTimeAsync(2_000);
        // A double-tap undone a moment later.
        takeBack(history);
        await vi.advanceTimersByTimeAsync(NAMED_SAVE_PUSH_HOLD_MS);
        await notified;
      } finally {
        restoreLogSink();
      }

      expect(history.standing()).toEqual([]);
      expect(history.pushed).toEqual([]);
      expect(history.pushClaims).toEqual([]);
      expect(expo.requests).toEqual([]);
      // Quietly: an alert gone before its push is not a failed push.
      expect(logged).toEqual([]);
    });

    it('fits in the save route, whose answer it waits behind', () => {
      const route = fs.readFileSync(path.join(process.cwd(), 'src/app/api/showcase/save/route.ts'), 'utf8');
      const maxDurationSeconds = Number(/export const maxDuration = (\d+);/.exec(route)?.[1]);
      // The hold, then a send with its retries, inside the function's time.
      expect(maxDurationSeconds * 1000).toBeGreaterThanOrEqual(NAMED_SAVE_PUSH_HOLD_MS + 20_000);
    });

    it('holds no grouped push: "Someone" names nobody', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { history, expo } = withCreatorPhone();
      const client = writtenTo(history);

      const notified = notifyPostSocialActivity(client, {
        type: 'post_saved', recipientUserId: 'creator-1', postId: 'post-1', actorUserId: 'reader-0',
      });
      await vi.advanceTimersByTimeAsync(0);
      await expect(notified).resolves.toMatchObject({ title: 'Someone saved your post' });
      expect(expo.requests).toHaveLength(1);
    });
  });

  // Review 4 finding #8: the alert goes between the reservation and the send.
  it('withdraws a named push whose alert goes after it was reserved: nothing reaches Expo, and the delivery says why', async () => {
    const { history, expo } = withCreatorPhone();
    history.recordSave('reader-1', 'post-1', true);
    const client = writtenTo({
      ...history,
      // The unsave lands while the post's push slot is being claimed, after the reservation.
      rpc: async (name: string, args?: Record<string, unknown>) => {
        if (name === 'check_backend_rate_limit') history.recordSave('reader-1', 'post-1', false);
        return history.rpc(name, args);
      },
    } as MobileNotificationHistory);

    await notifyPostSocialActivity(client, {
      type: 'post_saved', recipientUserId: 'creator-1', postId: 'post-1', actorUserId: 'reader-1', nameSaver: true, pushHoldMs: 0,
    });

    expect(expo.requests).toEqual([]);
    expect(history.outcomes).toEqual([expect.objectContaining({
      outcome: expect.objectContaining({ status: 'refused', message: 'The alert was taken back before its push went out.' }),
    })]);
  });

  it('asks again before a retried request: an alert gone during the backoff is not sent the second time', async () => {
    const { history } = withCreatorPhone();
    history.recordSave('reader-1', 'post-1', true);
    let requests = 0;
    vi.stubGlobal('fetch', async () => {
      requests += 1;
      // Expo is down for the first attempt; the unsave lands in the backoff.
      history.recordSave('reader-1', 'post-1', false);
      return new Response('unavailable', { status: 503 });
    });
    const client = writtenTo(history);

    await notifyPostSocialActivity(client, {
      type: 'post_saved', recipientUserId: 'creator-1', postId: 'post-1', actorUserId: 'reader-1', nameSaver: true, pushHoldMs: 0,
    });

    expect(requests).toBe(1);
    expect(history.outcomes).toEqual([expect.objectContaining({
      outcome: expect.objectContaining({ status: 'refused', attempt_count: 2 }),
    })]);
  });

  // Review 4 finding #12.
  it('spends no slot, and logs nothing, for a named alert gone before its push could be reserved', async () => {
    const { history, expo } = withCreatorPhone();
    history.recordSave('reader-1', 'post-1', true);
    const client = writtenTo({
      ...history,
      from: (table: string) => {
        // The unsave lands while the creator's devices are read.
        if (table === 'mobile_push_tokens') history.recordSave('reader-1', 'post-1', false);
        return history.from(table);
      },
    } as MobileNotificationHistory);
    const logged: BackendLogRecord[] = [];
    const restoreLogSink = setBackendLogSink((record) => { logged.push(record); });

    try {
      await notifyPostSocialActivity(client, {
        type: 'post_saved', recipientUserId: 'creator-1', postId: 'post-1', actorUserId: 'reader-1', nameSaver: true, pushHoldMs: 0,
      });
    } finally {
      restoreLogSink();
    }

    expect(history.pushClaims).toEqual([]);
    expect(history.pushed).toEqual([]);
    expect(expo.requests).toEqual([]);
    expect(logged).toEqual([]);

    // The post's next save still has its slot.
    history.recordSave('reader-2', 'post-1', true);
    await notifyPostSocialActivity(client, {
      type: 'post_saved', recipientUserId: 'creator-1', postId: 'post-1', actorUserId: 'reader-2', nameSaver: true, pushHoldMs: 0,
    });
    expect(history.pushClaims).toEqual([{ key: 'creator-1:post-1', allowed: true }]);
  });

  it.each([
    // What the function answered before it decided naming itself.
    { kind: 'no word on naming', answer: { wasCreated: true, notification: { id: 'notification-1', title: '@maya saved your post' } } },
    { kind: 'the oldest shape', answer: { created: true, notification: { id: 'notification-1', title: '@maya saved your post' } } },
    { kind: 'a write with no row', answer: { nameable: true, wasCreated: true, notification: null } },
    { kind: 'a flag that is not a boolean', answer: { nameable: true, wasCreated: 'true', notification: { id: 'notification-1' } } },
    { kind: 'a row that is not one', answer: { nameable: true, wasCreated: true, notification: 'notification-1' } },
    { kind: 'nothing at all', answer: null },
  ])('refuses a named save alert answered in $kind: it logs, answers null and pushes nothing', async ({ answer }) => {
    const expo = createExpoPushService();
    vi.stubGlobal('fetch', expo.fetch);
    const history = createMobileNotificationHistory({ ...SAVING, pushTo: { 'creator-1': [CREATOR_PHONE] } });
    const client = {
      from: (table: string) => history.from(table),
      rpc: async (name: string, args?: Record<string, unknown>) => (name === 'create_post_save_alert'
        ? { data: answer, error: null }
        : history.rpc(name, args)),
    } as unknown as SupabaseClient;
    const logged: BackendLogRecord[] = [];
    const restoreLogSink = setBackendLogSink((record) => { logged.push(record); });

    try {
      await expect(notifyPostSocialActivity(client, {
        type: 'post_saved', recipientUserId: 'creator-1', postId: 'post-1', actorUserId: 'reader-1', nameSaver: true, pushHoldMs: 0,
      })).resolves.toBeNull();
    } finally {
      restoreLogSink();
    }

    expect(logged).toEqual([expect.objectContaining({
      level: 'error',
      msg: 'failed_to_create_mobile_notification',
      errorMessage: 'Named save alert response was invalid.',
    })]);
    expect(history.preferenceReads).toEqual([]);
    expect(history.pushClaims).toEqual([]);
    expect(history.pushed).toEqual([]);
    expect(expo.requests).toEqual([]);
  });

  it('asks the database alone whether a saver may be named, and goes to whoever owns the post', async () => {
    const history = createMobileNotificationHistory(SAVING);
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    const client = writtenTo({
      ...history,
      rpc: async (name: string, args?: Record<string, unknown>) => {
        calls.push([name, args]);
        return history.rpc(name, args);
      },
    } as MobileNotificationHistory);
    history.recordSave('reader-1', 'post-1', true);

    await notifyPostSocialActivity(client, {
      type: 'post_saved', recipientUserId: 'creator-1', postId: 'post-1', actorUserId: 'reader-1', nameSaver: true, pushHoldMs: 0,
    });

    // No title, no recipient: the function builds the first and finds the second.
    expect(calls).toEqual([['create_post_save_alert', {
      p_post_id: 'post-1',
      p_saver_user_id: 'reader-1',
      p_body: 'It is in their saved media now.',
      p_deep_link: '/showcase/post-1',
    }]]);
  });

  it('refuses a grouped answer that does not say whether the alert was written anew, and pushes nothing', async () => {
    const expo = createExpoPushService();
    vi.stubGlobal('fetch', expo.fetch);
    const history = createMobileNotificationHistory({ pushTo: { 'creator-1': [CREATOR_PHONE] } });
    const client = {
      from: (table: string) => history.from(table),
      rpc: async (name: string, args?: Record<string, unknown>) => (name === 'upsert_mobile_notification'
        ? { data: { notification: { id: 'notification-1', user_id: 'creator-1', type: 'post_saved', category: 'social', title: 'Someone saved your post', body: '', event_count: 1 } }, error: null }
        : history.rpc(name, args)),
    } as unknown as SupabaseClient;
    const logged: BackendLogRecord[] = [];
    const restoreLogSink = setBackendLogSink((record) => { logged.push(record); });

    try {
      await expect(notifyPostSocialActivity(client, {
        type: 'post_saved', recipientUserId: 'creator-1', postId: 'post-1', actorUserId: 'reader-0',
      })).resolves.toBeNull();
    } finally {
      restoreLogSink();
    }

    expect(logged).toEqual([expect.objectContaining({
      msg: 'failed_to_create_mobile_notification',
      errorMessage: 'Aggregated mobile notification response was invalid.',
    })]);
    expect(history.pushClaims).toEqual([]);
    expect(history.pushed).toEqual([]);
    expect(expo.requests).toEqual([]);
  });

  it('lets a save alert push when its push slot cannot be checked', async () => {
    const { history } = withCreatorPhone();
    history.recordSave('reader-1', 'post-1', true);
    const client = {
      from: (table: string) => history.from(table),
      rpc: async (name: string, args?: Record<string, unknown>) => (name === 'check_backend_rate_limit'
        ? { data: null, error: { message: 'statement timeout' } }
        : history.rpc(name, args)),
    } as unknown as SupabaseClient;
    const logged: BackendLogRecord[] = [];
    const restoreLogSink = setBackendLogSink((record) => { logged.push(record); });

    try {
      await notifyPostSocialActivity(client, {
        type: 'post_saved', recipientUserId: 'creator-1', postId: 'post-1', actorUserId: 'reader-1', nameSaver: true, pushHoldMs: 0,
      });
    } finally {
      restoreLogSink();
    }

    expect(history.sent.map((row) => row.title)).toEqual(['@maya saved your post']);
    expect(history.pushed.map((push) => push.title)).toEqual(['@maya saved your post']);
    expect(logged.map((record) => record.msg)).toEqual(['failed_to_claim_post_save_push']);
  });

  // Review 4 finding #16: the slot's window as the notifier passes it.
  it("claims a post's save push for a quarter-hour, once, keyed by creator and post", async () => {
    const { history } = withCreatorPhone();
    const claims: Array<Record<string, unknown> | undefined> = [];
    const client = writtenTo({
      ...history,
      rpc: async (name: string, args?: Record<string, unknown>) => {
        if (name === 'check_backend_rate_limit') claims.push(args);
        return history.rpc(name, args);
      },
    } as MobileNotificationHistory);

    await notifyPostSocialActivity(client, { type: 'post_saved', recipientUserId: 'creator-1', postId: 'post-1', actorUserId: 'reader-0' });

    expect(claims).toEqual([{
      p_scope: 'post-save:push',
      p_subject_key: 'creator-1:post-1',
      p_limit: 1,
      p_window_seconds: 900,
    }]);
  });

  it('words its copy for both clients and spells the brand as the site does', async () => {
    // The web's Alerts prints these bodies as written, beside the app.
    const history = createMobileNotificationHistory();
    const client = writtenTo(history);
    const creation = { id: 'gen-1', user_id: 'user-1', category: 'image', template_run_id: null };

    await notifyGenerationStatus(client, creation, 'succeeded');
    await notifyGenerationStatus(client, creation, 'failed');
    await notifyMobilePurchasesRestored(client, 'user-1');

    const bodies = history.sent.map((row) => row.body);
    expect(bodies).toEqual([
      'Open it in your history.',
      `Open ${siteConfig.name} to try again or adjust the prompt.`,
      `Your ${siteConfig.name} credit balance was checked against verified purchase history.`,
    ]);
    expect(bodies.join(' ')).not.toMatch(/mobile|Magic Booklet/i);
  });
});
