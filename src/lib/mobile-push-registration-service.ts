import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BackendRateLimitError,
  MOBILE_PUSH_TOKEN_REGISTER_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import {
  MobileNotificationError,
  ensureMobileNotificationPreferences,
  normalizeMobilePushTokenPayload,
} from '@/lib/mobile-notifications';

type RouteBody = Record<string, unknown>;

export type MobilePushRegistrationRouteResult =
  | {
    ok: true;
    body: { success: true };
  }
  | {
    ok: false;
    body: RouteBody;
    status: number;
    rateLimitError?: BackendRateLimitError;
  };

type UserSupabaseClient = SupabaseClient;
type AdminSupabaseClient = Parameters<typeof enforceBackendRateLimit>[0] & SupabaseClient;

export interface MobilePushRegistrationRouteInput {
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

async function readRequestBody(input: MobilePushRegistrationRouteInput) {
  if ('requestBody' in input) return input.requestBody;
  return input.readRequestBody ? input.readRequestBody() : {};
}

function notificationErrorResult(error: MobileNotificationError): MobilePushRegistrationRouteResult {
  return {
    ok: false,
    body: { error: error.message },
    status: error.status,
  };
}

async function enforceRegistrationRateLimit(adminSupabase: AdminSupabaseClient, userId: string) {
  try {
    await enforceBackendRateLimit(adminSupabase, {
      ...MOBILE_PUSH_TOKEN_REGISTER_RATE_LIMIT,
      key: userId,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return {
        ok: false,
        body: { error: error.message },
        status: error.status,
        rateLimitError: error,
      } satisfies MobilePushRegistrationRouteResult;
    }

    console.error('Mobile push token registration rate limit check failed:', error);
    return {
      ok: false,
      body: { error: 'Failed to check mobile push token limits.' },
      status: 500,
    } satisfies MobilePushRegistrationRouteResult;
  }

  return null;
}

export async function registerMobilePushTokenForRoute(
  input: MobilePushRegistrationRouteInput,
): Promise<MobilePushRegistrationRouteResult> {
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

    const payload = normalizeMobilePushTokenPayload(await readRequestBody(input));
    const adminSupabase = input.getAdminSupabase() as AdminSupabaseClient;
    const rateLimitResult = await enforceRegistrationRateLimit(adminSupabase, userId);
    if (rateLimitResult) return rateLimitResult;

    const nowIso = new Date().toISOString();
    const { error } = await userSupabase
      .from('mobile_push_tokens')
      .upsert({
        user_id: userId,
        expo_push_token: payload.expoPushToken,
        platform: payload.platform,
        device_id: payload.deviceId,
        app_version: payload.appVersion,
        is_active: true,
        disabled_at: null,
        last_seen_at: nowIso,
      }, { onConflict: 'user_id,expo_push_token' });

    if (error) {
      throw new MobileNotificationError('Failed to register mobile push token.', 500);
    }

    if (payload.deviceId) {
      const { error: deactivateError } = await userSupabase
        .from('mobile_push_tokens')
        .update({
          is_active: false,
          disabled_at: nowIso,
        })
        .eq('user_id', userId)
        .eq('device_id', payload.deviceId)
        .eq('is_active', true)
        .neq('expo_push_token', payload.expoPushToken);

      if (deactivateError) {
        throw new MobileNotificationError('Failed to deactivate stale mobile push tokens.', 500);
      }
    }

    await ensureMobileNotificationPreferences(userSupabase, userId);

    return {
      ok: true,
      body: { success: true },
    };
  } catch (error) {
    if (error instanceof MobileNotificationError) {
      return notificationErrorResult(error);
    }

    console.error('Mobile push token registration failed:', error);
    return {
      ok: false,
      body: { error: 'Internal server error' },
      status: 500,
    };
  }
}
