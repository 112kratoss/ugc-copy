import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BackendRateLimitError,
  MOBILE_COMMERCE_SYNC_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import {
  MobileCommerceError,
  completeMobilePurchase,
  normalizeMobileCommercePayload,
  resolveMobilePurchaseAuthority,
  verifyMobilePurchase,
  type MobileCommerceSyncResult,
} from '@/lib/mobile-commerce';

type RouteBody = Record<string, unknown>;

export type MobileCommerceSyncRouteResult =
  | {
    ok: true;
    body: MobileCommerceSyncResult;
  }
  | {
    ok: false;
    body: RouteBody;
    status: number;
    rateLimitError?: BackendRateLimitError;
  };

type UserSupabaseClient = SupabaseClient;
type AdminSupabaseClient = Parameters<typeof enforceBackendRateLimit>[0] & SupabaseClient;

export interface MobileCommerceSyncRouteInput {
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

async function readRequestBody(input: MobileCommerceSyncRouteInput) {
  if ('requestBody' in input) return input.requestBody;
  return input.readRequestBody ? input.readRequestBody() : {};
}

function commerceErrorResult(error: MobileCommerceError): MobileCommerceSyncRouteResult {
  return {
    ok: false,
    body: { error: error.message },
    status: error.status,
  };
}

async function enforceSyncRateLimit(adminSupabase: AdminSupabaseClient, userId: string) {
  try {
    await enforceBackendRateLimit(adminSupabase, {
      ...MOBILE_COMMERCE_SYNC_RATE_LIMIT,
      key: userId,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return {
        ok: false,
        body: { error: error.message },
        status: error.status,
        rateLimitError: error,
      } satisfies MobileCommerceSyncRouteResult;
    }

    console.error('Mobile commerce sync rate limit check failed:', error);
    return {
      ok: false,
      body: { error: 'Failed to check commerce sync limits.' },
      status: 500,
    } satisfies MobileCommerceSyncRouteResult;
  }

  return null;
}

export async function syncMobileCommerceForRoute(
  input: MobileCommerceSyncRouteInput,
): Promise<MobileCommerceSyncRouteResult> {
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

    const adminSupabase = input.getAdminSupabase() as AdminSupabaseClient;
    const rateLimitResult = await enforceSyncRateLimit(adminSupabase, userId);
    if (rateLimitResult) return rateLimitResult;

    const payload = normalizeMobileCommercePayload(await readRequestBody(input));
    const authority = await resolveMobilePurchaseAuthority({
      adminSupabase,
      userId,
      productId: payload.productId,
      purchaseIntentId: payload.purchaseIntentId,
    });
    const verified = await verifyMobilePurchase({
      userId,
      productId: payload.productId,
      provider: payload.provider,
      transactionId: payload.transactionId,
      receiptToken: payload.receiptToken,
    });

    return {
      ok: true,
      body: await completeMobilePurchase({
        adminSupabase,
        userId,
        authority,
        provider: verified.provider,
        transactionId: verified.transactionId,
      }),
    };
  } catch (error) {
    if (error instanceof MobileCommerceError) {
      return commerceErrorResult(error);
    }

    console.error('Mobile commerce sync failed:', error);
    return {
      ok: false,
      body: { error: 'Internal server error' },
      status: 500,
    };
  }
}
