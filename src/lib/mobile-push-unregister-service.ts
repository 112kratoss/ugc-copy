import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logBackendError } from '@/lib/backend-logger';

import {
  BackendRateLimitError,
  MOBILE_PUSH_TOKEN_UNREGISTER_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';

type RouteBody = Record<string, unknown>;

/** The account-wide request retired the push tokens but could not end the account's connected apps. */
export const AGENT_ACCESS_NOT_ENDED_CODE = 'AGENT_ACCESS_NOT_ENDED';

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
  /**
   * Ends every app the account connected through the app's own authorization server
   * (`agent-oauth-server-service.ts`), for the account-wide request below. Given by the route
   * while that server is on; without it nothing is ended.
   */
  endAgentAccess?: (userId: string) => Promise<unknown>;
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
    // Sign out of all devices (product decisions 2026-10-17, item 9) asks for
    // the whole account by name, before it ends every session: a phone whose
    // session has ended can no longer retire its own token, and would keep
    // receiving the account's notifications. Only this exact value means it;
    // `allDevices`, which installed apps still send on an ordinary sign-out,
    // never does (below).
    const accountWide = body.scope === 'account';

    // A request has to name what it retires. Installed app builds still send
    // `allDevices: true` on sign-out from a phone that never registered for
    // push: it stood in for the missing token and device id, and it retired the
    // token of every other device on the account. It is refused like the empty
    // request it replaced, and ignored beside a token or a device id.
    if (!accountWide && !expoPushToken && !deviceId) {
      return {
        ok: false,
        body: { error: 'Provide an Expo push token or device ID.' },
        status: 400,
      };
    }

    // The account-wide request is what the web and the app send just before "Sign out everywhere"
    // (it is how installed apps already say so), and that sign-out ends sessions only. An app
    // connected through the app's own authorization server is not a session, so it is ended here:
    // signing out of every device still ends what acts as the account, as the consent page says.
    // Before the limit below, which every phone's ordinary sign-out counts against: a person at
    // that limit must still be able to end their agents, and ending them again changes nothing.
    // Every refusal after this point says so if they were not ended.
    let agentAccessEnded = true;
    if (accountWide && input.endAgentAccess) {
      try {
        await input.endAgentAccess(user.id);
      } catch (error) {
        agentAccessEnded = false;
        logBackendError('agent_access_sign_out_everywhere_failed', { userId: user.id, error });
      }
    }
    const notEnded: RouteBody = agentAccessEnded ? {} : { code: AGENT_ACCESS_NOT_ENDED_CODE };

    try {
      await enforceBackendRateLimit(input.getAdminSupabase() as AdminSupabaseClient, {
        ...MOBILE_PUSH_TOKEN_UNREGISTER_RATE_LIMIT,
        key: user.id,
      });
    } catch (error) {
      if (error instanceof BackendRateLimitError) {
        return {
          ok: false,
          body: { error: error.message, ...notEnded },
          status: error.status,
          // The limiter's own response carries no code: without one the answer is built here.
          ...(agentAccessEnded ? { rateLimitError: error } : {}),
        };
      }

      logBackendError('mobile_push_token_unregister_rate_limit_check_failed', { error: error });
      return {
        ok: false,
        body: { error: 'Failed to check mobile push token limits.', ...notEnded },
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

    if (!accountWide) {
      query = expoPushToken ? query.eq('expo_push_token', expoPushToken) : query;
      query = !expoPushToken && deviceId ? query.eq('device_id', deviceId) : query;
    }
    // Live rows only. A row the receipts job, a newer token on the same device
    // or an earlier sign-out already retired keeps the disabled_at it was given
    // then, so the column still says when that token stopped receiving pushes.
    query = query.eq('is_active', true);

    const { error } = await query;
    if (error) {
      return {
        ok: false,
        body: { error: 'Failed to unregister mobile push token.', ...notEnded },
        status: 500,
      };
    }

    if (!agentAccessEnded) {
      return {
        ok: false,
        // The code is what the web reads to tell the person, after the sign-out, that their
        // connected apps are still connected (`AppShellAccount.tsx`).
        body: { error: 'Failed to disconnect the account\'s connected apps.', code: AGENT_ACCESS_NOT_ENDED_CODE },
        status: 500,
      };
    }

    return { ok: true, body: { success: true } };
  } catch (error) {
    logBackendError('mobile_push_token_unregister_failed', { error: error });
    return { ok: false, body: { error: 'Internal server error' }, status: 500 };
  }
}
