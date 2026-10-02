import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { isGuestUser } from '@/lib/account-identity';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logBackendError } from '@/lib/backend-logger';

import {
  BackendRateLimitError,
  MOBILE_NOTIFICATION_READ_ALL_RATE_LIMIT,
  MOBILE_NOTIFICATION_READ_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import {
  MobileNotificationError,
  toMobileNotificationRecord,
  type MobileNotificationRecord,
} from '@/lib/mobile-notifications';

type RouteBody = Record<string, unknown>;

export type MobileNotificationInboxRouteResult =
  | {
    ok: true;
    body:
      | { success: true }
      | {
        success: true;
        notifications: MobileNotificationRecord[];
        unreadCount: number;
      };
  }
  | {
    ok: false;
    body: RouteBody;
    status: number;
    rateLimitError?: BackendRateLimitError;
  };

type UserSupabaseClient = SupabaseClient;
type AdminSupabaseClient = Parameters<typeof enforceBackendRateLimit>[0] & SupabaseClient;

type AuthenticatedInput = {
  userSupabase: unknown;
};

export type MobileNotificationInboxGetInput = AuthenticatedInput & {
  before?: string | null;
  limitValue?: string | null;
};

export type MobileNotificationReadInput = AuthenticatedInput & {
  getAdminSupabase: () => unknown;
  readRequestBody?: () => Promise<unknown>;
  requestBody?: unknown;
};

export type MobileNotificationReadAllInput = AuthenticatedInput & {
  getAdminSupabase: () => unknown;
};

async function getAuthenticatedMobileUserId(userSupabase: UserSupabaseClient) {
  const {
    data: { user },
    error: authError,
  } = await getVerifiedAuthUserResult(userSupabase);

  // Registered-only. A guest has no follows, comments or marketplace activity
  // to be notified about, and a push token registered against a guest row is
  // stranded the moment that identity is linked to an account.
  return authError || !user || isGuestUser(user) ? null : user.id;
}

function clampLimit(value?: string | null) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 30;
  return Math.max(1, Math.min(80, Math.trunc(parsed)));
}

function normalizeIds(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function readRequestBody(input: MobileNotificationReadInput) {
  if ('requestBody' in input) return input.requestBody;
  return input.readRequestBody ? input.readRequestBody() : {};
}

function errorResult(error: MobileNotificationError): MobileNotificationInboxRouteResult {
  return {
    ok: false,
    body: { error: error.message },
    status: error.status,
  };
}

async function enforceNotificationReadRateLimit({
  adminSupabase,
  all,
  userId,
}: {
  adminSupabase: AdminSupabaseClient;
  all: boolean;
  userId: string;
}): Promise<MobileNotificationInboxRouteResult | null> {
  try {
    await enforceBackendRateLimit(adminSupabase, {
      ...(all ? MOBILE_NOTIFICATION_READ_ALL_RATE_LIMIT : MOBILE_NOTIFICATION_READ_RATE_LIMIT),
      key: userId,
    });
    return null;
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return {
        ok: false,
        body: { error: error.message },
        status: error.status,
        rateLimitError: error,
      };
    }

    logBackendError('mobile_notifications_rate_limit_check_failed', { message: `Mobile notifications ${all ? 'read-all' : 'read'} rate limit check failed:`, error: error, });
    return {
      ok: false,
      body: { error: 'Failed to check mobile notification read limits.' },
      status: 500,
    };
  }
}

export async function getMobileNotificationInboxForRoute(
  input: MobileNotificationInboxGetInput,
): Promise<MobileNotificationInboxRouteResult> {
  try {
    const userSupabase = input.userSupabase as UserSupabaseClient;
    const userId = await getAuthenticatedMobileUserId(userSupabase);
    if (!userId) {
      return { ok: false, body: { error: 'Unauthorized' }, status: 401 };
    }

    // An alert's place follows its last event: its arrival, or the latest event
    // grouped into it. Never updated_at, which every write to the row stamps:
    // marking an alert read is a write, and it used to lift the alert to the
    // top of the list as "Just now". `id` settles alerts that share a time.
    let query = userSupabase
      .from('mobile_notifications')
      .select('id, type, category, title, body, deep_link, object_type, object_id, event_count, is_read, created_at, last_event_at')
      .eq('user_id', userId)
      .order('last_event_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(clampLimit(input.limitValue));

    if (input.before) {
      query = query.lt('last_event_at', input.before);
    }

    const [{ data, error }, unreadResult] = await Promise.all([
      query,
      userSupabase
        .from('mobile_notifications')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('is_read', false),
    ]);

    if (error || unreadResult.error) {
      throw new MobileNotificationError('Failed to load notifications.', 500);
    }

    return {
      ok: true,
      body: {
        success: true,
        notifications: (data ?? []).map((row) => toMobileNotificationRecord(row)),
        unreadCount: unreadResult.count ?? 0,
      },
    };
  } catch (error) {
    if (error instanceof MobileNotificationError) return errorResult(error);
    logBackendError('mobile_notifications_list_failed', { error: error });
    return { ok: false, body: { error: 'Internal server error' }, status: 500 };
  }
}

export async function markMobileNotificationsReadForRoute(
  input: MobileNotificationReadInput,
): Promise<MobileNotificationInboxRouteResult> {
  try {
    const userSupabase = input.userSupabase as UserSupabaseClient;
    const userId = await getAuthenticatedMobileUserId(userSupabase);
    if (!userId) {
      return { ok: false, body: { error: 'Unauthorized' }, status: 401 };
    }

    const ids = normalizeIds(asRecord(await readRequestBody(input)).ids);
    if (ids.length === 0) {
      return { ok: false, body: { error: 'Missing notification IDs.' }, status: 400 };
    }

    const rateLimitResult = await enforceNotificationReadRateLimit({
      adminSupabase: input.getAdminSupabase() as AdminSupabaseClient,
      all: false,
      userId,
    });
    if (rateLimitResult) return rateLimitResult;

    const { error } = await userSupabase
      .from('mobile_notifications')
      .update({ is_read: true })
      .eq('user_id', userId)
      .in('id', ids);

    if (error) {
      return { ok: false, body: { error: 'Failed to mark notifications read.' }, status: 500 };
    }

    return { ok: true, body: { success: true } };
  } catch (error) {
    logBackendError('mobile_notifications_read_failed', { error: error });
    return { ok: false, body: { error: 'Internal server error' }, status: 500 };
  }
}

export async function markAllMobileNotificationsReadForRoute(
  input: MobileNotificationReadAllInput,
): Promise<MobileNotificationInboxRouteResult> {
  try {
    const userSupabase = input.userSupabase as UserSupabaseClient;
    const userId = await getAuthenticatedMobileUserId(userSupabase);
    if (!userId) {
      return { ok: false, body: { error: 'Unauthorized' }, status: 401 };
    }

    const rateLimitResult = await enforceNotificationReadRateLimit({
      adminSupabase: input.getAdminSupabase() as AdminSupabaseClient,
      all: true,
      userId,
    });
    if (rateLimitResult) return rateLimitResult;

    const { error } = await userSupabase
      .from('mobile_notifications')
      .update({ is_read: true })
      .eq('user_id', userId)
      .eq('is_read', false);

    if (error) {
      return { ok: false, body: { error: 'Failed to mark notifications read.' }, status: 500 };
    }

    return { ok: true, body: { success: true } };
  } catch (error) {
    logBackendError('mobile_notifications_read_all_failed', { error: error });
    return { ok: false, body: { error: 'Internal server error' }, status: 500 };
  }
}
