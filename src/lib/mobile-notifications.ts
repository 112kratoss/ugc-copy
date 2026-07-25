import type { SupabaseClient } from '@supabase/supabase-js';
import { logBackendError } from '@/lib/backend-logger';

import {
  EXTERNAL_API_REQUEST_TIMEOUT_MS,
  fetchWithProviderTimeout,
} from '@/lib/provider-fetch';

type MobilePushPlatform = 'ios' | 'android';
export type MobileNotificationCategory = 'generation' | 'commerce' | 'social' | 'system';
export type MobileNotificationType =
  | 'generation_succeeded'
  | 'generation_failed'
  | 'credits_purchased'
  | 'referral_reward_earned'
  | 'referral_reward_reversed'
  | 'purchases_restored'
  | 'marketplace_unlocked'
  | 'post_resource_unlocked'
  | 'creator_followed'
  | 'post_saved'
  | 'post_remixed'
  | 'post_shared';

export interface NormalizedMobilePushTokenPayload {
  expoPushToken: string;
  platform: MobilePushPlatform;
  deviceId: string | null;
  appVersion: string | null;
}

export interface MobileNotificationPreferences {
  pushEnabled: boolean;
  generationEnabled: boolean;
  commerceEnabled: boolean;
  socialEnabled: boolean;
}

export interface MobileNotificationRecord {
  id: string;
  type: MobileNotificationType;
  category: MobileNotificationCategory;
  title: string;
  body: string;
  deepLink: string | null;
  objectType: string | null;
  objectId: string | null;
  eventCount: number;
  isRead: boolean;
  createdAt: string;
  updatedAt: string;
}

type NotificationRow = Record<string, unknown>;
type DeliveryRow = NotificationRow;
type ExpoReceipt = {
  status?: unknown;
  message?: unknown;
  details?: unknown;
};

type ExpoPushSendResult =
  | {
    status: 'ok';
    id: string | null;
  }
  | {
    status: 'error';
    message: string;
    details: Record<string, unknown> | null;
  };
type ExpoPushPriority = 'default' | 'normal' | 'high';
type ExpoPushSendPayload = {
  expoPushToken: string;
  title: string;
  body: string;
  data: Record<string, string | number | boolean | null>;
  channelId?: string;
  priority?: ExpoPushPriority;
  fetcher?: typeof fetch;
};

const DEFAULT_PREFERENCES: MobileNotificationPreferences = {
  pushEnabled: true,
  generationEnabled: true,
  commerceEnabled: true,
  socialEnabled: true,
};
const DEFAULT_RECEIPT_BATCH_SIZE = 1000;
const MAX_RECEIPT_BATCH_SIZE = 1000;
const RECEIPT_MIN_AGE_MINUTES = 15;
const RECEIPT_STALE_AFTER_HOURS = 24;
const DEFAULT_EXPO_PUSH_MAX_ATTEMPTS = 3;
const DEFAULT_EXPO_PUSH_RETRY_BASE_DELAY_MS = 500;
const RETRYABLE_DELIVERY_BATCH_SIZE = 100;
const DELIVERY_RETENTION_DAYS = 90;
const READ_NOTIFICATION_RETENTION_DAYS = 180;

export class MobileNotificationError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
    this.name = 'MobileNotificationError';
  }
}

class ExpoPushRetryError extends Error {
  constructor(
    message: string,
    public readonly attemptCount: number,
    public readonly cause: unknown
  ) {
    super(message);
    this.name = 'ExpoPushRetryError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeOptionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeBoolean(value: unknown, fallback: boolean) {
  return typeof value === 'boolean' ? value : fallback;
}

function isExpoPushToken(value: string) {
  return /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/.test(value);
}

function asNotificationType(value: unknown): MobileNotificationType {
  const type = String(value);
  if (
    type === 'generation_succeeded' ||
    type === 'generation_failed' ||
    type === 'credits_purchased' ||
    type === 'referral_reward_earned' ||
    type === 'referral_reward_reversed' ||
    type === 'purchases_restored' ||
    type === 'marketplace_unlocked' ||
    type === 'post_resource_unlocked' ||
    type === 'creator_followed' ||
    type === 'post_saved' ||
    type === 'post_remixed' ||
    type === 'post_shared'
  ) {
    return type;
  }
  return 'generation_succeeded';
}

function asNotificationCategory(value: unknown): MobileNotificationCategory {
  const category = String(value);
  if (category === 'generation' || category === 'commerce' || category === 'social' || category === 'system') {
    return category;
  }
  return 'system';
}

function rowString(row: NotificationRow, key: string) {
  const value = row[key];
  return typeof value === 'string' ? value : null;
}

function rowNumber(row: NotificationRow, key: string, fallback = 0) {
  const value = row[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function rowBoolean(row: NotificationRow, key: string, fallback = false) {
  const value = row[key];
  return typeof value === 'boolean' ? value : fallback;
}

function isDeviceNotRegistered(details: unknown) {
  return isRecord(details) && details.error === 'DeviceNotRegistered';
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof ExpoPushRetryError) {
    return getErrorMessage(error.cause, error.message || fallback);
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  return fallback;
}

function toProviderErrorDetails(error: unknown): Record<string, unknown> | null {
  if (error instanceof ExpoPushRetryError) {
    return {
      attempts: error.attemptCount,
      cause: toProviderErrorDetails(error.cause),
    };
  }

  if (error instanceof MobileNotificationError) {
    return {
      name: error.name,
      status: error.status,
      message: error.message,
    };
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  return null;
}

function getExpoPushAttemptCount(error: unknown, fallback = 1) {
  return error instanceof ExpoPushRetryError ? error.attemptCount : fallback;
}

function isTransientExpoPushError(error: unknown) {
  if (!(error instanceof MobileNotificationError)) {
    return error instanceof Error;
  }

  return error.status === 429 || error.status >= 500;
}

function expoPushRetryDelayMs(attempt: number) {
  return DEFAULT_EXPO_PUSH_RETRY_BASE_DELAY_MS * (2 ** Math.max(0, attempt - 1));
}

function wait(ms: number) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkValues<T>(values: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

export function normalizeMobilePushTokenPayload(body: unknown): NormalizedMobilePushTokenPayload {
  if (!isRecord(body)) {
    throw new MobileNotificationError('Invalid mobile push token payload.');
  }

  const expoPushToken = normalizeOptionalString(body.expoPushToken ?? body.token);
  const platform = body.platform;
  if (!expoPushToken || !isExpoPushToken(expoPushToken)) {
    throw new MobileNotificationError('Invalid Expo push token.');
  }

  if (platform !== 'ios' && platform !== 'android') {
    throw new MobileNotificationError('Invalid mobile push token platform.');
  }

  return {
    expoPushToken,
    platform,
    deviceId: normalizeOptionalString(body.deviceId),
    appVersion: normalizeOptionalString(body.appVersion),
  };
}

export function normalizeMobileNotificationPreferencesPatch(body: unknown): Partial<MobileNotificationPreferences> {
  if (!isRecord(body)) {
    throw new MobileNotificationError('Invalid notification preferences payload.');
  }

  const patch: Partial<MobileNotificationPreferences> = {};
  if (typeof body.pushEnabled === 'boolean') patch.pushEnabled = body.pushEnabled;
  if (typeof body.generationEnabled === 'boolean') patch.generationEnabled = body.generationEnabled;
  if (typeof body.commerceEnabled === 'boolean') patch.commerceEnabled = body.commerceEnabled;
  if (typeof body.socialEnabled === 'boolean') patch.socialEnabled = body.socialEnabled;
  return patch;
}

export function toMobileNotificationPreferences(row: NotificationRow | null | undefined): MobileNotificationPreferences {
  return {
    pushEnabled: normalizeBoolean(row?.push_enabled, DEFAULT_PREFERENCES.pushEnabled),
    generationEnabled: normalizeBoolean(row?.generation_enabled, DEFAULT_PREFERENCES.generationEnabled),
    commerceEnabled: normalizeBoolean(row?.commerce_enabled, DEFAULT_PREFERENCES.commerceEnabled),
    socialEnabled: normalizeBoolean(row?.social_enabled, DEFAULT_PREFERENCES.socialEnabled),
  };
}

export function toMobileNotificationRecord(row: NotificationRow): MobileNotificationRecord {
  return {
    id: rowString(row, 'id') ?? '',
    type: asNotificationType(row.type),
    category: asNotificationCategory(row.category),
    title: rowString(row, 'title') ?? '',
    body: rowString(row, 'body') ?? '',
    deepLink: rowString(row, 'deep_link'),
    objectType: rowString(row, 'object_type'),
    objectId: rowString(row, 'object_id'),
    eventCount: rowNumber(row, 'event_count', 1),
    isRead: rowBoolean(row, 'is_read'),
    createdAt: rowString(row, 'created_at') ?? new Date(0).toISOString(),
    updatedAt: rowString(row, 'updated_at') ?? rowString(row, 'created_at') ?? new Date(0).toISOString(),
  };
}

export function buildMobileNotificationDeepLink(target:
  | { kind: 'generation'; generationId: string }
  | { kind: 'showcasePost'; postId: string }
  | { kind: 'marketplaceResource'; resourceId: string }
  | { kind: 'creatorProfile'; username: string }
  | { kind: 'notifications' }
) {
  if (target.kind === 'generation') {
    return `/viewer?source=studio-creations&initialId=${encodeURIComponent(target.generationId)}`;
  }

  if (target.kind === 'showcasePost') {
    return `/viewer?source=showcase-feed&initialId=${encodeURIComponent(target.postId)}`;
  }

  if (target.kind === 'marketplaceResource') {
    return `/marketplace/${encodeURIComponent(target.resourceId)}`;
  }

  if (target.kind === 'creatorProfile') {
    return `/creators/${encodeURIComponent(target.username)}`;
  }

  return '/studio';
}

export async function sendExpoPushNotification({
  expoPushToken,
  title,
  body,
  data,
  channelId = 'default',
  priority = 'high',
  fetcher = fetch,
}: ExpoPushSendPayload): Promise<ExpoPushSendResult> {
  const response = await fetchWithProviderTimeout(
    'https://exp.host/--/api/v2/push/send',
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: expoPushToken,
        sound: 'default',
        title,
        body,
        channelId,
        priority,
        data,
      }),
    },
    EXTERNAL_API_REQUEST_TIMEOUT_MS,
    fetcher,
    'Expo push send'
  );

  const payload = await response.json().catch(() => null) as {
    data?: unknown;
    errors?: unknown;
  } | null;

  if (!response.ok) {
    const message = Array.isArray(payload?.errors) && isRecord(payload.errors[0])
      ? normalizeOptionalString(payload.errors[0].message) ?? 'Expo push service rejected the notification.'
      : 'Expo push service rejected the notification.';
    throw new MobileNotificationError(message, response.status === 429 ? 429 : Math.max(response.status, 400));
  }

  const firstResult = Array.isArray(payload?.data) ? payload?.data[0] : payload?.data;
  if (!isRecord(firstResult)) {
    throw new MobileNotificationError('Expo push service returned an invalid response.', 502);
  }

  if (firstResult.status === 'ok') {
    return {
      status: 'ok' as const,
      id: normalizeOptionalString(firstResult.id),
    };
  }

  return {
    status: 'error' as const,
    message: normalizeOptionalString(firstResult.message) ?? 'Expo push delivery failed.',
    details: isRecord(firstResult.details) ? firstResult.details : null,
  };
}

export async function sendExpoPushNotificationWithRetry({
  maxAttempts = DEFAULT_EXPO_PUSH_MAX_ATTEMPTS,
  retryDelayMs = expoPushRetryDelayMs,
  ...payload
}: ExpoPushSendPayload & {
  maxAttempts?: number;
  retryDelayMs?: (attempt: number) => number;
}): Promise<{ result: ExpoPushSendResult; attemptCount: number }> {
  const boundedMaxAttempts = Number.isFinite(maxAttempts)
    ? Math.max(1, Math.min(Math.trunc(maxAttempts), DEFAULT_EXPO_PUSH_MAX_ATTEMPTS))
    : DEFAULT_EXPO_PUSH_MAX_ATTEMPTS;
  let attemptCount = 0;

  for (;;) {
    attemptCount += 1;

    try {
      const result = await sendExpoPushNotification(payload);
      return { result, attemptCount };
    } catch (error) {
      if (attemptCount >= boundedMaxAttempts || !isTransientExpoPushError(error)) {
        throw new ExpoPushRetryError(
          getErrorMessage(error, 'Expo push send failed after retry attempts.'),
          attemptCount,
          error,
        );
      }

      await wait(retryDelayMs(attemptCount));
    }
  }
}

export async function ensureMobileNotificationPreferences(supabase: SupabaseClient, userId: string) {
  const { data, error } = await supabase
    .from('mobile_notification_preferences')
    .select('push_enabled, generation_enabled, commerce_enabled, social_enabled')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    throw new MobileNotificationError('Failed to load mobile notification preferences.', 500);
  }

  if (data) {
    return toMobileNotificationPreferences(data as NotificationRow);
  }

  const { data: inserted, error: insertError } = await supabase
    .from('mobile_notification_preferences')
    .upsert({ user_id: userId }, { onConflict: 'user_id' })
    .select('push_enabled, generation_enabled, commerce_enabled, social_enabled')
    .single();

  if (insertError) {
    throw new MobileNotificationError('Failed to create mobile notification preferences.', 500);
  }

  return toMobileNotificationPreferences(inserted as NotificationRow);
}

function shouldPushForPreferences(preferences: MobileNotificationPreferences, category: MobileNotificationCategory) {
  if (!preferences.pushEnabled) {
    return false;
  }

  if (category === 'generation') return preferences.generationEnabled;
  if (category === 'commerce') return preferences.commerceEnabled;
  if (category === 'social') return preferences.socialEnabled;
  return true;
}

function priorityForNotificationCategory(category: MobileNotificationCategory): ExpoPushPriority {
  return category === 'social' ? 'default' : 'high';
}

async function createAggregatedMobileNotification({
  adminSupabase,
  userId,
  actorUserId,
  type,
  category,
  title,
  body,
  deepLink,
  objectType,
  objectId,
  dedupeKey,
  aggregationKey,
}: {
  adminSupabase: SupabaseClient;
  userId: string;
  actorUserId: string | null;
  type: MobileNotificationType;
  category: MobileNotificationCategory;
  title: string;
  body: string;
  deepLink: string | null;
  objectType: string | null;
  objectId: string | null;
  dedupeKey: string | null;
  aggregationKey: string;
}): Promise<{ notification: MobileNotificationRecord; wasCreated: boolean }> {
  const { data, error } = await adminSupabase.rpc('upsert_mobile_notification', {
    p_user_id: userId,
    p_actor_user_id: actorUserId,
    p_type: type,
    p_category: category,
    p_title: title,
    p_body: body,
    p_deep_link: deepLink,
    p_object_type: objectType,
    p_object_id: objectId,
    p_dedupe_key: dedupeKey,
    p_aggregation_key: aggregationKey,
  });

  if (error) {
    throw new MobileNotificationError('Failed to upsert aggregated mobile notification.', 500);
  }

  if (!isRecord(data) || !isRecord(data.notification)) {
    throw new MobileNotificationError('Aggregated mobile notification response was invalid.', 500);
  }

  return {
    notification: toMobileNotificationRecord(data.notification),
    wasCreated: rowBoolean(data, 'wasCreated', true),
  };
}

async function sendMobilePushForNotification(
  adminSupabase: SupabaseClient,
  notification: MobileNotificationRecord & { userId: string }
) {
  const { data, error } = await adminSupabase
    .from('mobile_push_tokens')
    .select('id, expo_push_token, platform')
    .eq('user_id', notification.userId)
    .eq('is_active', true);

  if (error) {
    throw new MobileNotificationError('Failed to load mobile push tokens.', 500);
  }

  const tokens = (data ?? []) as Array<{
    id?: string | null;
    expo_push_token?: string | null;
    platform?: string | null;
  }>;
  if (tokens.length === 0) {
    return;
  }

  let firstTicketId: string | null = null;
  let firstError: string | null = null;
  const pushedAt = new Date().toISOString();

  async function recordDeliveryAttempt(values: Record<string, unknown>) {
    const { error: insertError } = await adminSupabase
      .from('mobile_push_deliveries')
      .insert(values);

    if (insertError) {
      throw new MobileNotificationError('Failed to store mobile push delivery.', 500);
    }
  }

  for (const token of tokens) {
    if (!token.expo_push_token) {
      continue;
    }

    let result: ExpoPushSendResult;
    let attemptCount = 1;
    try {
      const sendAttempt = await sendExpoPushNotificationWithRetry({
        expoPushToken: token.expo_push_token,
        title: notification.title,
        body: notification.body,
        priority: priorityForNotificationCategory(notification.category),
        data: {
          notificationId: notification.id,
          type: notification.type,
          category: notification.category,
          deepLink: notification.deepLink,
        },
      });
      result = sendAttempt.result;
      attemptCount = sendAttempt.attemptCount;
    } catch (error) {
      const providerMessage = getErrorMessage(error, 'Expo push send failed before the provider accepted the notification.');
      const failedAttemptCount = getExpoPushAttemptCount(error, 1);
      firstError ??= providerMessage;

      await recordDeliveryAttempt({
        notification_id: notification.id,
        user_id: notification.userId,
        token_id: token.id ?? null,
        expo_push_token: token.expo_push_token,
        platform: token.platform === 'android' ? 'android' : 'ios',
        send_status: 'error',
        receipt_status: 'error',
        receipt_checked_at: pushedAt,
        receipt_message: 'Push send failed before a receipt was created.',
        provider_message: providerMessage,
        provider_details: toProviderErrorDetails(error),
        attempt_count: failedAttemptCount,
        last_attempt_at: pushedAt,
      });
      continue;
    }

    if (result.status === 'ok') {
      firstTicketId ??= result.id ?? null;
      await recordDeliveryAttempt({
        notification_id: notification.id,
        user_id: notification.userId,
        token_id: token.id ?? null,
        expo_push_token: token.expo_push_token,
        platform: token.platform === 'android' ? 'android' : 'ios',
        push_ticket_id: result.id ?? null,
        send_status: 'sent',
        receipt_status: 'pending',
        attempt_count: attemptCount,
        sent_at: pushedAt,
        last_attempt_at: pushedAt,
      });
      continue;
    }

    firstError ??= result.message;
    await recordDeliveryAttempt({
      notification_id: notification.id,
      user_id: notification.userId,
      token_id: token.id ?? null,
      expo_push_token: token.expo_push_token,
      platform: token.platform === 'android' ? 'android' : 'ios',
      send_status: 'error',
      receipt_status: 'error',
      receipt_checked_at: pushedAt,
      receipt_error_code: isRecord(result.details) ? normalizeOptionalString(result.details.error) : null,
      receipt_message: result.message,
      provider_message: result.message,
      provider_details: isRecord(result.details) ? result.details : null,
      attempt_count: 1,
      last_attempt_at: pushedAt,
    });

    if (isDeviceNotRegistered(result.details) && token.id) {
      await adminSupabase
        .from('mobile_push_tokens')
        .update({
          is_active: false,
          disabled_at: pushedAt,
        })
        .eq('id', token.id);
    }
  }

  await adminSupabase
    .from('mobile_notifications')
    .update({
      pushed_at: pushedAt,
      push_ticket_id: firstTicketId,
      push_error: firstError,
    })
    .eq('id', notification.id);
}

async function fetchExpoPushReceipts(
  ticketIds: string[],
  fetcher: typeof fetch
): Promise<Record<string, ExpoReceipt>> {
  const response = await fetchWithProviderTimeout(
    'https://exp.host/--/api/v2/push/getReceipts',
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ids: ticketIds }),
    },
    EXTERNAL_API_REQUEST_TIMEOUT_MS,
    fetcher,
    'Expo push receipts'
  );

  const payload = await response.json().catch(() => null) as {
    data?: unknown;
  } | null;

  if (!response.ok) {
    throw new MobileNotificationError('Expo push receipts request failed.', 502);
  }

  if (!isRecord(payload?.data)) {
    throw new MobileNotificationError('Expo push receipts response was invalid.', 502);
  }

  return payload.data as Record<string, ExpoReceipt>;
}

export async function hasPendingMobilePushReceipts(
  adminSupabase: SupabaseClient,
  { now = new Date() }: { now?: Date } = {}
): Promise<boolean> {
  const dueBefore = new Date(now.getTime() - RECEIPT_MIN_AGE_MINUTES * 60 * 1000).toISOString();
  const { data, error } = await adminSupabase
    .from('mobile_push_deliveries')
    .select('id')
    .eq('receipt_status', 'pending')
    .lte('sent_at', dueBefore)
    .limit(1);

  if (error) {
    throw new MobileNotificationError('Failed to check pending mobile push receipts.', 500);
  }

  return Array.isArray(data) && data.length > 0;
}

async function hasRetryableMobilePushDeliveries(adminSupabase: SupabaseClient): Promise<boolean> {
  const { data, error } = await adminSupabase
    .from('mobile_push_deliveries')
    .select('id')
    .eq('send_status', 'error')
    .eq('receipt_status', 'error')
    .is('push_ticket_id', null)
    .lt('attempt_count', DEFAULT_EXPO_PUSH_MAX_ATTEMPTS)
    .limit(1);

  if (error) {
    throw new MobileNotificationError('Failed to check retryable mobile push deliveries.', 500);
  }

  return Array.isArray(data) && data.length > 0;
}

async function hasMobileNotificationRetentionWork(
  adminSupabase: SupabaseClient,
  now: Date
): Promise<boolean> {
  const deliveryCutoff = new Date(now.getTime() - DELIVERY_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const notificationCutoff = new Date(now.getTime() - READ_NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data: deliveryData, error: deliveryError } = await adminSupabase
    .from('mobile_push_deliveries')
    .select('id')
    .lt('created_at', deliveryCutoff)
    .limit(1);

  if (deliveryError) {
    throw new MobileNotificationError('Failed to check mobile push delivery retention.', 500);
  }

  if (Array.isArray(deliveryData) && deliveryData.length > 0) {
    return true;
  }

  const { data: notificationData, error: notificationError } = await adminSupabase
    .from('mobile_notifications')
    .select('id')
    .eq('is_read', true)
    .lt('updated_at', notificationCutoff)
    .limit(1);

  if (notificationError) {
    throw new MobileNotificationError('Failed to check mobile notification retention.', 500);
  }

  return Array.isArray(notificationData) && notificationData.length > 0;
}

export async function hasMobilePushMaintenanceWork(
  adminSupabase: SupabaseClient,
  { now = new Date() }: { now?: Date } = {}
): Promise<boolean> {
  if (await hasPendingMobilePushReceipts(adminSupabase, { now })) {
    return true;
  }

  if (await hasRetryableMobilePushDeliveries(adminSupabase)) {
    return true;
  }

  return hasMobileNotificationRetentionWork(adminSupabase, now);
}

export async function processPendingMobilePushReceipts(
  adminSupabase: SupabaseClient,
  {
    fetcher = fetch,
    now = new Date(),
    batchSize = DEFAULT_RECEIPT_BATCH_SIZE,
  }: {
    fetcher?: typeof fetch;
    now?: Date;
    batchSize?: number;
  } = {}
) {
  const nowIso = now.toISOString();
  const dueBefore = new Date(now.getTime() - RECEIPT_MIN_AGE_MINUTES * 60 * 1000).toISOString();
  const staleThreshold = now.getTime() - (RECEIPT_STALE_AFTER_HOURS * 60 * 60 * 1000);
  const boundedBatchSize = Number.isFinite(batchSize)
    ? Math.max(1, Math.min(Math.trunc(batchSize), MAX_RECEIPT_BATCH_SIZE))
    : DEFAULT_RECEIPT_BATCH_SIZE;
  const { data, error } = await adminSupabase
    .from('mobile_push_deliveries')
    .select('id, token_id, push_ticket_id, receipt_status, sent_at')
    .eq('receipt_status', 'pending')
    .lte('sent_at', dueBefore)
    .order('sent_at', { ascending: true })
    .limit(boundedBatchSize);

  if (error) {
    throw new MobileNotificationError('Failed to load mobile push deliveries.', 500);
  }

  const deliveries = (data ?? []) as DeliveryRow[];
  const staleDeliveries = deliveries.filter((delivery) => {
    const sentAt = rowString(delivery, 'sent_at');
    const timestamp = sentAt ? Date.parse(sentAt) : Number.NaN;
    return !rowString(delivery, 'push_ticket_id') || !Number.isFinite(timestamp) || timestamp <= staleThreshold;
  });
  const activeDeliveries = deliveries.filter((delivery) => !staleDeliveries.includes(delivery));

  let staleCount = 0;
  for (const delivery of staleDeliveries) {
    const deliveryId = rowString(delivery, 'id');
    if (!deliveryId) {
      continue;
    }

    staleCount += 1;
    await adminSupabase
      .from('mobile_push_deliveries')
      .update({
        receipt_status: 'stale',
        receipt_checked_at: nowIso,
        receipt_message: 'Receipt unavailable after 24 hours.',
      })
      .eq('id', deliveryId);
  }

  let updatedCount = 0;
  let disabledTokenCount = 0;
  const receiptLookups = chunkValues(
    activeDeliveries
      .map((delivery) => rowString(delivery, 'push_ticket_id'))
      .filter((ticketId): ticketId is string => Boolean(ticketId)),
    MAX_RECEIPT_BATCH_SIZE
  );
  const receiptsByTicketId: Record<string, ExpoReceipt> = {};

  for (const ticketBatch of receiptLookups) {
    const nextReceipts = await fetchExpoPushReceipts(ticketBatch, fetcher);
    Object.assign(receiptsByTicketId, nextReceipts);
  }

  for (const delivery of activeDeliveries) {
    const deliveryId = rowString(delivery, 'id');
    const tokenId = rowString(delivery, 'token_id');
    const ticketId = rowString(delivery, 'push_ticket_id');

    if (!deliveryId || !ticketId) {
      continue;
    }

    const receipt = receiptsByTicketId[ticketId];
    if (!isRecord(receipt)) {
      continue;
    }

    updatedCount += 1;
    const receiptDetails = isRecord(receipt.details) ? receipt.details : null;
    const receiptStatus = receipt.status === 'ok' ? 'ok' : 'error';
    const receiptMessage = normalizeOptionalString(receipt.message)
      ?? (receiptStatus === 'ok' ? 'Delivered to push provider.' : 'Expo receipt reported a delivery error.');
    const receiptErrorCode = receiptDetails ? normalizeOptionalString(receiptDetails.error) : null;

    await adminSupabase
      .from('mobile_push_deliveries')
      .update({
        receipt_status: receiptStatus,
        receipt_checked_at: nowIso,
        receipt_error_code: receiptErrorCode,
        receipt_message: receiptMessage,
        provider_details: receiptDetails,
      })
      .eq('id', deliveryId);

    if (receiptErrorCode === 'DeviceNotRegistered' && tokenId) {
      disabledTokenCount += 1;
      await adminSupabase
        .from('mobile_push_tokens')
        .update({
          is_active: false,
          disabled_at: nowIso,
        })
        .eq('id', tokenId);
    }
  }

  return {
    checkedCount: deliveries.length,
    updatedCount,
    staleCount,
    disabledTokenCount,
  };
}

async function processRetryableMobilePushDeliveries(
  adminSupabase: SupabaseClient,
  {
    fetcher = fetch,
    now = new Date(),
    batchSize = RETRYABLE_DELIVERY_BATCH_SIZE,
  }: {
    fetcher?: typeof fetch;
    now?: Date;
    batchSize?: number;
  } = {}
) {
  const nowIso = now.toISOString();
  const boundedBatchSize = Number.isFinite(batchSize)
    ? Math.max(1, Math.min(Math.trunc(batchSize), RETRYABLE_DELIVERY_BATCH_SIZE))
    : RETRYABLE_DELIVERY_BATCH_SIZE;

  const { data, error } = await adminSupabase
    .from('mobile_push_deliveries')
    .select('id, notification_id, user_id, token_id, expo_push_token, platform, attempt_count')
    .eq('send_status', 'error')
    .eq('receipt_status', 'error')
    .is('push_ticket_id', null)
    .lt('attempt_count', DEFAULT_EXPO_PUSH_MAX_ATTEMPTS)
    .order('last_attempt_at', { ascending: true })
    .limit(boundedBatchSize);

  if (error) {
    throw new MobileNotificationError('Failed to load retryable mobile push deliveries.', 500);
  }

  const deliveries = (data ?? []) as DeliveryRow[];
  let retriedCount = 0;
  let resentCount = 0;
  let retryFailedCount = 0;
  let disabledTokenCount = 0;

  for (const delivery of deliveries) {
    const deliveryId = rowString(delivery, 'id');
    const notificationId = rowString(delivery, 'notification_id');
    const userId = rowString(delivery, 'user_id');
    const tokenId = rowString(delivery, 'token_id');
    const expoPushToken = rowString(delivery, 'expo_push_token');
    const priorAttemptCount = rowNumber(delivery, 'attempt_count', 0);

    if (!deliveryId || !notificationId || !userId || !expoPushToken) {
      continue;
    }

    const { data: notificationData, error: notificationError } = await adminSupabase
      .from('mobile_notifications')
      .select('id, type, category, title, body, deep_link')
      .eq('id', notificationId)
      .maybeSingle();

    if (notificationError) {
      throw new MobileNotificationError('Failed to load notification for push retry.', 500);
    }

    if (!notificationData) {
      await adminSupabase
        .from('mobile_push_deliveries')
        .update({
          receipt_message: 'Notification no longer exists.',
          last_attempt_at: nowIso,
        })
        .eq('id', deliveryId);
      continue;
    }

    const notification = toMobileNotificationRecord(notificationData as NotificationRow);
    const remainingAttempts = DEFAULT_EXPO_PUSH_MAX_ATTEMPTS - priorAttemptCount;
    retriedCount += 1;

    try {
      const { result, attemptCount } = await sendExpoPushNotificationWithRetry({
        expoPushToken,
        title: notification.title,
        body: notification.body,
        priority: priorityForNotificationCategory(notification.category),
        data: {
          notificationId: notification.id,
          type: notification.type,
          category: notification.category,
          deepLink: notification.deepLink,
        },
        fetcher,
        maxAttempts: remainingAttempts,
      });

      if (result.status === 'ok') {
        resentCount += 1;
        await adminSupabase
          .from('mobile_push_deliveries')
          .update({
            push_ticket_id: result.id ?? null,
            send_status: 'sent',
            receipt_status: 'pending',
            receipt_checked_at: null,
            receipt_error_code: null,
            receipt_message: null,
            provider_message: null,
            provider_details: null,
            attempt_count: priorAttemptCount + attemptCount,
            sent_at: nowIso,
            last_attempt_at: nowIso,
          })
          .eq('id', deliveryId);
        continue;
      }

      retryFailedCount += 1;
      await adminSupabase
        .from('mobile_push_deliveries')
        .update({
          receipt_error_code: isRecord(result.details) ? normalizeOptionalString(result.details.error) : null,
          receipt_message: result.message,
          provider_message: result.message,
          provider_details: isRecord(result.details) ? result.details : null,
          attempt_count: priorAttemptCount + attemptCount,
          last_attempt_at: nowIso,
        })
        .eq('id', deliveryId);

      if (isDeviceNotRegistered(result.details) && tokenId) {
        disabledTokenCount += 1;
        await adminSupabase
          .from('mobile_push_tokens')
          .update({
            is_active: false,
            disabled_at: nowIso,
          })
          .eq('id', tokenId);
      }
    } catch (error) {
      retryFailedCount += 1;
      const attemptCount = getExpoPushAttemptCount(error, remainingAttempts);
      await adminSupabase
        .from('mobile_push_deliveries')
        .update({
          provider_message: getErrorMessage(error, 'Expo push retry failed.'),
          provider_details: toProviderErrorDetails(error),
          attempt_count: Math.min(DEFAULT_EXPO_PUSH_MAX_ATTEMPTS, priorAttemptCount + attemptCount),
          last_attempt_at: nowIso,
        })
        .eq('id', deliveryId);
    }
  }

  return {
    retryableCount: deliveries.length,
    retriedCount,
    resentCount,
    retryFailedCount,
    retryDisabledTokenCount: disabledTokenCount,
  };
}

async function pruneMobileNotificationRetention(
  adminSupabase: SupabaseClient,
  { now = new Date() }: { now?: Date } = {}
) {
  const deliveryCutoff = new Date(now.getTime() - DELIVERY_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const notificationCutoff = new Date(now.getTime() - READ_NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { error: deliveryDeleteError } = await adminSupabase
    .from('mobile_push_deliveries')
    .delete()
    .lt('created_at', deliveryCutoff);

  if (deliveryDeleteError) {
    throw new MobileNotificationError('Failed to prune mobile push delivery history.', 500);
  }

  const { error: notificationDeleteError } = await adminSupabase
    .from('mobile_notifications')
    .delete()
    .eq('is_read', true)
    .lt('updated_at', notificationCutoff);

  if (notificationDeleteError) {
    throw new MobileNotificationError('Failed to prune read mobile notifications.', 500);
  }

  return {
    deliveryRetentionDays: DELIVERY_RETENTION_DAYS,
    readNotificationRetentionDays: READ_NOTIFICATION_RETENTION_DAYS,
  };
}

export async function processMobilePushMaintenance(
  adminSupabase: SupabaseClient,
  {
    fetcher = fetch,
    now = new Date(),
    batchSize = DEFAULT_RECEIPT_BATCH_SIZE,
  }: {
    fetcher?: typeof fetch;
    now?: Date;
    batchSize?: number;
  } = {}
) {
  const receiptSummary = await processPendingMobilePushReceipts(adminSupabase, {
    fetcher,
    now,
    batchSize,
  });
  const retrySummary = await processRetryableMobilePushDeliveries(adminSupabase, {
    fetcher,
    now,
  });
  const retentionSummary = await pruneMobileNotificationRetention(adminSupabase, { now });

  return {
    ...receiptSummary,
    ...retrySummary,
    ...retentionSummary,
    disabledTokenCount: receiptSummary.disabledTokenCount + retrySummary.retryDisabledTokenCount,
  };
}

export async function createMobileNotification({
  adminSupabase,
  userId,
  actorUserId = null,
  type,
  category,
  title,
  body,
  deepLink = null,
  objectType = null,
  objectId = null,
  dedupeKey = null,
  aggregationKey = null,
}: {
  adminSupabase: SupabaseClient;
  userId: string;
  actorUserId?: string | null;
  type: MobileNotificationType;
  category: MobileNotificationCategory;
  title: string;
  body: string;
  deepLink?: string | null;
  objectType?: string | null;
  objectId?: string | null;
  dedupeKey?: string | null;
  aggregationKey?: string | null;
}): Promise<MobileNotificationRecord | null> {
  if (actorUserId && actorUserId === userId) {
    return null;
  }

  if (dedupeKey) {
    const { data: duplicate, error: duplicateError } = await adminSupabase
      .from('mobile_notifications')
      .select('*')
      .eq('user_id', userId)
      .eq('dedupe_key', dedupeKey)
      .maybeSingle();

    if (duplicateError) {
      throw new MobileNotificationError('Failed to check mobile notification history.', 500);
    }

    if (duplicate) {
      return toMobileNotificationRecord(duplicate as NotificationRow);
    }
  }

  if (aggregationKey) {
    const { notification, wasCreated } = await createAggregatedMobileNotification({
      adminSupabase,
      userId,
      actorUserId,
      type,
      category,
      title,
      body,
      deepLink,
      objectType,
      objectId,
      dedupeKey,
      aggregationKey,
    });

    if (wasCreated) {
      const preferences = await ensureMobileNotificationPreferences(adminSupabase, userId);
      if (shouldPushForPreferences(preferences, category)) {
        try {
          await sendMobilePushForNotification(adminSupabase, { ...notification, userId });
        } catch (error) {
          logBackendError('failed_to_send_mobile_push_notification', { error: error });
        }
      }
    }

    return notification;
  }

  const { data: inserted, error: insertError } = await adminSupabase
    .from('mobile_notifications')
    .insert({
      user_id: userId,
      actor_user_id: actorUserId,
      type,
      category,
      title,
      body,
      deep_link: deepLink,
      object_type: objectType,
      object_id: objectId,
      dedupe_key: dedupeKey,
      aggregation_key: aggregationKey,
    })
    .select('*')
    .single();

  if (insertError) {
    throw new MobileNotificationError('Failed to create mobile notification history.', 500);
  }

  const notification = toMobileNotificationRecord(inserted as NotificationRow);
  const preferences = await ensureMobileNotificationPreferences(adminSupabase, userId);

  if (shouldPushForPreferences(preferences, category)) {
    try {
      await sendMobilePushForNotification(adminSupabase, { ...notification, userId });
    } catch (error) {
      logBackendError('failed_to_send_mobile_push_notification', { error: error });
    }
  }

  return notification;
}

async function createMobileNotificationSafely(params: Parameters<typeof createMobileNotification>[0]) {
  try {
    return await createMobileNotification(params);
  } catch (error) {
    logBackendError('failed_to_create_mobile_notification', { error: error });
    return null;
  }
}

function generationLabel(category?: string | null) {
  if (category === 'video' || category === 'ugc-ad') return 'video';
  if (category === 'motion') return 'motion render';
  if (category === 'text') return 'post';
  return 'image';
}

export async function notifyGenerationStatus(
  adminSupabase: SupabaseClient,
  generation: { id: string; user_id: string; category?: string | null; model?: string | null },
  status: 'succeeded' | 'failed'
) {
  const label = generationLabel(generation.category);
  return createMobileNotificationSafely({
    adminSupabase,
    userId: generation.user_id,
    type: status === 'succeeded' ? 'generation_succeeded' : 'generation_failed',
    category: 'generation',
    title: status === 'succeeded' ? `Your ${label} is ready` : `Your ${label} failed`,
    body: status === 'succeeded'
      ? 'Open it in your mobile history.'
      : 'Open Magicbooklet to try again or adjust the prompt.',
    deepLink: buildMobileNotificationDeepLink({ kind: 'generation', generationId: generation.id }),
    objectType: 'generation',
    objectId: generation.id,
    dedupeKey: `generation:${generation.id}:${status}`,
  });
}

export async function notifyMobileCreditPurchase(
  adminSupabase: SupabaseClient,
  params: { userId: string; credits: number | null; transactionId?: string | null }
) {
  return createMobileNotificationSafely({
    adminSupabase,
    userId: params.userId,
    type: 'credits_purchased',
    category: 'commerce',
    title: 'Credits added',
    body: typeof params.credits === 'number'
      ? `Your balance is now ${params.credits} credits.`
      : 'Your credit purchase is complete.',
    deepLink: '/profile',
    objectType: 'credits',
    objectId: params.transactionId ?? null,
    dedupeKey: params.transactionId ? `credits:${params.transactionId}` : null,
  });
}

export async function notifyReferralReward(
  adminSupabase: SupabaseClient,
  params: {
    userId: string;
    credits: number;
    rewardId: string;
    reversed?: boolean;
    eventKey?: string;
  }
) {
  const credits = Math.max(0, Math.trunc(params.credits));
  const reversed = Boolean(params.reversed);
  const eventKey = params.eventKey?.trim() || (reversed ? 'reversed' : 'granted');

  return createMobileNotificationSafely({
    adminSupabase,
    userId: params.userId,
    type: reversed ? 'referral_reward_reversed' : 'referral_reward_earned',
    category: 'commerce',
    title: reversed ? 'Referral reward reversed' : 'Referral credits earned',
    body: reversed
      ? `${credits} referral ${credits === 1 ? 'credit was' : 'credits were'} removed after a payment reversal.`
      : `You earned ${credits} bonus ${credits === 1 ? 'credit' : 'credits'} from Invite & Earn.`,
    deepLink: '/invite',
    objectType: 'referral_reward',
    objectId: params.rewardId,
    dedupeKey: `referral-reward:${params.rewardId}:${eventKey}`,
  });
}

export async function notifyMobilePurchasesRestored(adminSupabase: SupabaseClient, userId: string) {
  return createMobileNotificationSafely({
    adminSupabase,
    userId,
    type: 'purchases_restored',
    category: 'commerce',
    title: 'Purchase history refreshed',
    body: 'Your Magic Booklet credit balance was checked against verified purchase history.',
    deepLink: '/profile',
    objectType: 'purchase_history_refresh',
    objectId: userId,
    dedupeKey: `purchase-history-refresh:${userId}:${new Date().toISOString().slice(0, 10)}`,
  });
}

export async function notifyMarketplaceUnlockCompleted(
  adminSupabase: SupabaseClient,
  params: {
    buyerUserId: string;
    sellerUserId: string;
    assetId: string;
    alreadyProcessed?: boolean;
  }
) {
  if (params.alreadyProcessed) return null;

  await createMobileNotificationSafely({
    adminSupabase,
    userId: params.buyerUserId,
    type: 'marketplace_unlocked',
    category: 'commerce',
    title: 'Resource unlocked',
    body: 'Your marketplace resource is ready to open.',
    deepLink: buildMobileNotificationDeepLink({ kind: 'marketplaceResource', resourceId: params.assetId }),
    objectType: 'marketplace_asset',
    objectId: params.assetId,
    dedupeKey: `marketplace-unlock:${params.assetId}:${params.buyerUserId}`,
  });

  return createMobileNotificationSafely({
    adminSupabase,
    userId: params.sellerUserId,
    actorUserId: params.buyerUserId,
    type: 'marketplace_unlocked',
    category: 'commerce',
    title: 'You made a resource sale',
    body: 'Someone unlocked your marketplace resource.',
    deepLink: buildMobileNotificationDeepLink({ kind: 'marketplaceResource', resourceId: params.assetId }),
    objectType: 'marketplace_asset',
    objectId: params.assetId,
    dedupeKey: `marketplace-sale:${params.assetId}:${params.buyerUserId}`,
  });
}

export async function notifyPostResourceUnlockCompleted(
  adminSupabase: SupabaseClient,
  params: {
    buyerUserId: string;
    ownerUserId: string;
    postId: string;
    bundleId?: string | null;
    alreadyProcessed?: boolean;
  }
) {
  if (params.alreadyProcessed) return null;

  await createMobileNotificationSafely({
    adminSupabase,
    userId: params.buyerUserId,
    type: 'post_resource_unlocked',
    category: 'commerce',
    title: 'Post resources unlocked',
    body: 'The prompt, files, or workflow are ready to view.',
    deepLink: buildMobileNotificationDeepLink({ kind: 'showcasePost', postId: params.postId }),
    objectType: 'post',
    objectId: params.postId,
    dedupeKey: `post-resource-unlock:${params.postId}:${params.buyerUserId}`,
  });

  return createMobileNotificationSafely({
    adminSupabase,
    userId: params.ownerUserId,
    actorUserId: params.buyerUserId,
    type: 'post_resource_unlocked',
    category: 'social',
    title: 'Someone unlocked your post',
    body: 'A creator opened the resources attached to your post.',
    deepLink: buildMobileNotificationDeepLink({ kind: 'showcasePost', postId: params.postId }),
    objectType: 'post',
    objectId: params.postId,
    dedupeKey: `post-resource-sale:${params.postId}:${params.buyerUserId}`,
  });
}

export async function notifyCreatorFollowed(
  adminSupabase: SupabaseClient,
  params: { followerUserId: string; followingUserId: string; followerUsername?: string | null }
) {
  return createMobileNotificationSafely({
    adminSupabase,
    userId: params.followingUserId,
    actorUserId: params.followerUserId,
    type: 'creator_followed',
    category: 'social',
    title: 'New follower',
    body: params.followerUsername ? `@${params.followerUsername} followed you.` : 'Someone followed your creator profile.',
    deepLink: buildMobileNotificationDeepLink({ kind: 'notifications' }),
    objectType: 'profile',
    objectId: params.followerUserId,
    dedupeKey: `creator-follow:${params.followerUserId}:${params.followingUserId}`,
  });
}

function socialAggregationWindow(date = new Date()) {
  const minutes = Math.floor(date.getTime() / (15 * 60 * 1000));
  return String(minutes);
}

export async function notifyPostSocialActivity(
  adminSupabase: SupabaseClient,
  params: {
    type: 'post_saved' | 'post_remixed' | 'post_shared';
    recipientUserId: string | null | undefined;
    actorUserId: string | null | undefined;
    postId: string;
  }
) {
  if (!params.recipientUserId || !params.actorUserId) {
    return null;
  }

  const verb =
    params.type === 'post_saved'
      ? 'saved'
      : params.type === 'post_remixed'
        ? 'remixed'
        : 'shared';

  return createMobileNotificationSafely({
    adminSupabase,
    userId: params.recipientUserId,
    actorUserId: params.actorUserId,
    type: params.type,
    category: 'social',
    title: `Someone ${verb} your post`,
    body: 'Creator activity is grouped here to keep your phone quiet.',
    deepLink: buildMobileNotificationDeepLink({ kind: 'showcasePost', postId: params.postId }),
    objectType: 'post',
    objectId: params.postId,
    aggregationKey: `post-social:${params.type}:${params.recipientUserId}:${params.postId}:${socialAggregationWindow()}`,
  });
}
