import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logBackendError } from '@/lib/backend-logger';

import {
  BackendRateLimitError,
  MOBILE_PUSH_TOKEN_UNREGISTER_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';

type RouteBody = Record<string, unknown>;

export type MobilePushUnregisterRouteResult =
  | { ok: true; body: { success: true } }
  | {
    ok: false;
    body: RouteBody;
    status: number;
    rateLimitError?: BackendRateLimitError;
  };

type UserSupabaseClient = SupabaseClient;
type AdminSupabaseClient = Parameters<typeof enforceBackendRateLimit>[0] & SupabaseClient;

export interface MobilePushUnregisterRouteInput {
  getAdminSupabase: () => unknown;
  now?: () => Date;
  readRequestBody?: () => Promise<unknown>;
  requestBody?: unknown;
  userSupabase: unknown;
}

function optionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function readRequestBody(input: MobilePushUnregisterRouteInput) {
  if ('requestBody' in input) return input.requestBody;
  return input.readRequestBody ? input.readRequestBody().catch(() => ({})) : {};
}

export async function unregisterMobilePushTokenForRoute(
  input: MobilePushUnregisterRouteInput,
): Promise<MobilePushUnregisterRouteResult> {
  try {
    const userSupabase = input.userSupabase as UserSupabaseClient;
    const {
      data: { user },
      error: authError,
    } = await getVerifiedAuthUserResult(userSupabase);

    if (authError || !user) {
      return { ok: false, body: { error: 'Unauthorized' }, status: 401 };
    }

    const body = asRecord(await readRequestBody(input));
    const expoPushToken = optionalString(body.expoPushToken ?? body.token);
    const deviceId = optionalString(body.deviceId);

    // A request has to name what it retires. Installed app builds still send
    // `allDevices: true` on sign-out from a phone that never registered for
    // push: it stood in for the missing token and device id, and it retired the
    // token of every other device on the account. It is refused like the empty
    // request it replaced, and ignored beside a token or a device id.
    if (!expoPushToken && !deviceId) {
      return {
        ok: false,
        body: { error: 'Provide an Expo push token or device ID.' },
        status: 400,
      };
    }

    try {
      await enforceBackendRateLimit(input.getAdminSupabase() as AdminSupabaseClient, {
        ...MOBILE_PUSH_TOKEN_UNREGISTER_RATE_LIMIT,
        key: user.id,
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

      logBackendError('mobile_push_token_unregister_rate_limit_check_failed', { error: error });
      return {
        ok: false,
        body: { error: 'Failed to check mobile push token limits.' },
        status: 500,
      };
    }

    let query = userSupabase
      .from('mobile_push_tokens')
      .update({
        is_active: false,
        disabled_at: (input.now ?? (() => new Date()))().toISOString(),
      })
      .eq('user_id', user.id);

    query = expoPushToken ? query.eq('expo_push_token', expoPushToken) : query;
    query = !expoPushToken && deviceId ? query.eq('device_id', deviceId) : query;
    // Live rows only. A row the receipts job, a newer token on the same device
    // or an earlier sign-out already retired keeps the disabled_at it was given
    // then, so the column still says when that token stopped receiving pushes.
    query = query.eq('is_active', true);

    const { error } = await query;
    if (error) {
      return {
        ok: false,
        body: { error: 'Failed to unregister mobile push token.' },
        status: 500,
      };
    }

    return { ok: true, body: { success: true } };
  } catch (error) {
    logBackendError('mobile_push_token_unregister_failed', { error: error });
    return { ok: false, body: { error: 'Internal server error' }, status: 500 };
  }
}
