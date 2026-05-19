import type { SupabaseClient } from '@supabase/supabase-js';

export type MobilePushPlatform = 'ios' | 'android';
export type MobileNotificationCategory = 'generation' | 'commerce' | 'social' | 'system';
export type MobileNotificationType =
  | 'generation_succeeded'
  | 'generation_failed'
  | 'credits_purchased'
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

const DEFAULT_PREFERENCES: MobileNotificationPreferences = {
  pushEnabled: true,
  generationEnabled: true,
  commerceEnabled: true,
  socialEnabled: true,
};

export class MobileNotificationError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
    this.name = 'MobileNotificationError';
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
  fetcher = fetch,
}: {
  expoPushToken: string;
  title: string;
  body: string;
  data: Record<string, string | number | boolean | null>;
  fetcher?: typeof fetch;
}) {
  const response = await fetcher('https://exp.host/--/api/v2/push/send', {
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
      data,
    }),
  });

  const payload = await response.json().catch(() => null) as {
    data?: unknown;
    errors?: unknown;
  } | null;

  if (!response.ok) {
    throw new MobileNotificationError('Expo push service rejected the notification.', 502);
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

async function sendMobilePushForNotification(
  adminSupabase: SupabaseClient,
  notification: MobileNotificationRecord & { userId: string }
) {
  const { data, error } = await adminSupabase
    .from('mobile_push_tokens')
    .select('id, expo_push_token')
    .eq('user_id', notification.userId)
    .eq('is_active', true);

  if (error) {
    throw new MobileNotificationError('Failed to load mobile push tokens.', 500);
  }

  const tokens = (data ?? []) as Array<{ id?: string | null; expo_push_token?: string | null }>;
  if (tokens.length === 0) {
    return;
  }

  let firstTicketId: string | null = null;
  let firstError: string | null = null;

  for (const token of tokens) {
    if (!token.expo_push_token) {
      continue;
    }

    const result = await sendExpoPushNotification({
      expoPushToken: token.expo_push_token,
      title: notification.title,
      body: notification.body,
      data: {
        notificationId: notification.id,
        type: notification.type,
        category: notification.category,
        deepLink: notification.deepLink,
      },
    });

    if (result.status === 'ok') {
      firstTicketId ??= result.id ?? null;
      continue;
    }

    firstError ??= result.message;
    if (isRecord(result.details) && result.details.error === 'DeviceNotRegistered' && token.id) {
      await adminSupabase
        .from('mobile_push_tokens')
        .update({
          is_active: false,
          disabled_at: new Date().toISOString(),
        })
        .eq('id', token.id);
    }
  }

  await adminSupabase
    .from('mobile_notifications')
    .update({
      pushed_at: new Date().toISOString(),
      push_ticket_id: firstTicketId,
      push_error: firstError,
    })
    .eq('id', notification.id);
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
    const { data: existing, error: existingError } = await adminSupabase
      .from('mobile_notifications')
      .select('*')
      .eq('user_id', userId)
      .eq('aggregation_key', aggregationKey)
      .maybeSingle();

    if (existingError) {
      throw new MobileNotificationError('Failed to check mobile notification history.', 500);
    }

    if (existing) {
      const existingRow = existing as NotificationRow;
      const { data: updated, error: updateError } = await adminSupabase
        .from('mobile_notifications')
        .update({
          actor_user_id: actorUserId,
          title,
          body,
          deep_link: deepLink,
          object_type: objectType,
          object_id: objectId,
          event_count: rowNumber(existingRow, 'event_count', 1) + 1,
          is_read: false,
        })
        .eq('id', rowString(existingRow, 'id') ?? '')
        .select('*')
        .single();

      if (updateError) {
        throw new MobileNotificationError('Failed to update mobile notification history.', 500);
      }

      return toMobileNotificationRecord(updated as NotificationRow);
    }
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
      console.error('Failed to send mobile push notification:', error);
    }
  }

  return notification;
}

export async function createMobileNotificationSafely(params: Parameters<typeof createMobileNotification>[0]) {
  try {
    return await createMobileNotification(params);
  } catch (error) {
    console.error('Failed to create mobile notification:', error);
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

export async function notifyMobilePurchasesRestored(adminSupabase: SupabaseClient, userId: string) {
  return createMobileNotificationSafely({
    adminSupabase,
    userId,
    type: 'purchases_restored',
    category: 'commerce',
    title: 'Purchases restored',
    body: 'Your mobile entitlements have been restored.',
    deepLink: '/profile',
    objectType: 'restore',
    objectId: userId,
    dedupeKey: `restore:${userId}:${new Date().toISOString().slice(0, 10)}`,
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
