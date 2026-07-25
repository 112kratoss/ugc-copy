import type { SupabaseClient } from '@supabase/supabase-js';
import { logBackendError } from '@/lib/backend-logger';

import {
  BackendRateLimitError,
  MOBILE_NOTIFICATION_PREFERENCES_UPDATE_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import {
  MobileNotificationError,
  ensureMobileNotificationPreferences,
  normalizeMobileNotificationPreferencesPatch,
  toMobileNotificationPreferences,
  type MobileNotificationPreferences,
} from '@/lib/mobile-notifications';

type RouteBody = Record<string, unknown>;

export type MobileNotificationPreferencesRouteResult =
  | {
    ok: true;
    body: {
      success: true;
      preferences: MobileNotificationPreferences;
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

export interface MobileNotificationPreferencesGetInput {
  userSupabase: unknown;
}

export interface MobileNotificationPreferencesUpdateInput {
  getAdminSupabase: () => unknown;
  readRequestBody?: () => Promise<unknown>;
  requestBody?: unknown;
  userSupabase: unknown;
}

async function getAuthenticatedMobileUserId(userSupabase: UserSupabaseClient) {
  const {
    data: { user },
    error: authError,
  } = await userSupabase.auth.getUser();

  return authError || !user ? null : user.id;
}

function mobileNotificationErrorResult(error: MobileNotificationError): MobileNotificationPreferencesRouteResult {
  return {
    ok: false,
    body: { error: error.message },
    status: error.status,
  };
}

async function readRequestBody(input: MobileNotificationPreferencesUpdateInput) {
  if ('requestBody' in input) return input.requestBody;
  return input.readRequestBody ? input.readRequestBody() : {};
}

export async function getMobileNotificationPreferencesForRoute(
  input: MobileNotificationPreferencesGetInput,
): Promise<MobileNotificationPreferencesRouteResult> {
  try {
    const userSupabase = input.userSupabase as UserSupabaseClient;
    const userId = await getAuthenticatedMobileUserId(userSupabase);
    if (!userId) {
      return {
        ok: false,
        body: { error: 'Unauthorized' },
        status: 401,
      };
    }

    const preferences = await ensureMobileNotificationPreferences(userSupabase, userId);
    return {
      ok: true,
      body: { success: true, preferences },
    };
  } catch (error) {
    if (error instanceof MobileNotificationError) {
      return mobileNotificationErrorResult(error);
    }

    logBackendError('mobile_notification_preferences_load_failed', { error: error });
    return {
      ok: false,
      body: { error: 'Internal server error' },
      status: 500,
    };
  }
}

export async function updateMobileNotificationPreferencesForRoute(
  input: MobileNotificationPreferencesUpdateInput,
): Promise<MobileNotificationPreferencesRouteResult> {
  try {
    const userSupabase = input.userSupabase as UserSupabaseClient;
    const userId = await getAuthenticatedMobileUserId(userSupabase);
    if (!userId) {
      return {
        ok: false,
        body: { error: 'Unauthorized' },
        status: 401,
      };
    }

    const patch = normalizeMobileNotificationPreferencesPatch(await readRequestBody(input));
    const adminSupabase = input.getAdminSupabase() as AdminSupabaseClient;
    try {
      await enforceBackendRateLimit(adminSupabase, {
        ...MOBILE_NOTIFICATION_PREFERENCES_UPDATE_RATE_LIMIT,
        key: userId,
      });
    } catch (error) {
      if (error instanceof BackendRateLimitError) {
        return {
          ok: false,
          body: { error: error.message },
          status: error.status,
          rateLimitError: error,
        };
      }

      logBackendError('mobile_notification_preferences_rate_limit_check_failed', { error: error });
      return {
        ok: false,
        body: { error: 'Failed to check mobile notification preference limits.' },
        status: 500,
      };
    }

    const { data, error } = await userSupabase
      .from('mobile_notification_preferences')
      .upsert({
        user_id: userId,
        ...(patch.pushEnabled !== undefined ? { push_enabled: patch.pushEnabled } : {}),
        ...(patch.generationEnabled !== undefined ? { generation_enabled: patch.generationEnabled } : {}),
        ...(patch.commerceEnabled !== undefined ? { commerce_enabled: patch.commerceEnabled } : {}),
        ...(patch.socialEnabled !== undefined ? { social_enabled: patch.socialEnabled } : {}),
      }, { onConflict: 'user_id' })
      .select('push_enabled, generation_enabled, commerce_enabled, social_enabled')
      .single();

    if (error) {
      throw new MobileNotificationError('Failed to update mobile notification preferences.', 500);
    }

    return {
      ok: true,
      body: {
        success: true,
        preferences: toMobileNotificationPreferences(data),
      },
    };
  } catch (error) {
    if (error instanceof MobileNotificationError) {
      return mobileNotificationErrorResult(error);
    }

    logBackendError('mobile_notification_preferences_update_failed', { error: error });
    return {
      ok: false,
      body: { error: 'Internal server error' },
      status: 500,
    };
  }
}
