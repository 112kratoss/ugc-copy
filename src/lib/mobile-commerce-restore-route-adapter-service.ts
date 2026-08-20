import 'server-only';
import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { logBackendRouteError } from '@/lib/backend-logger';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders, getApiRequestId } from '@/lib/api-cache';
import {
  BackendRateLimitError,
  MOBILE_COMMERCE_RESTORE_RATE_LIMIT,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { MobileCommerceError, restoreMobileEntitlements } from '@/lib/mobile-commerce';
import { withProviderFetchRequestId } from '@/lib/provider-fetch';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type MobileCommerceRestoreRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  logError?: typeof logBackendRouteError;
  restoreMobileEntitlements?: typeof restoreMobileEntitlements;
  withProviderFetchRequestId?: typeof withProviderFetchRequestId;
};

function resolveDependencies(dependencies: MobileCommerceRestoreRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    enforceBackendRateLimit: dependencies?.enforceBackendRateLimit ?? enforceBackendRateLimit,
    logError: dependencies?.logError ?? logBackendRouteError,
    restoreMobileEntitlements: dependencies?.restoreMobileEntitlements ?? restoreMobileEntitlements,
    withProviderFetchRequestId: dependencies?.withProviderFetchRequestId ?? withProviderFetchRequestId,
  };
}

async function enforceRestoreRateLimit(
  adminSupabase: ReturnType<typeof createServiceClient>,
  userId: string,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  try {
    await dependencies.enforceBackendRateLimit(adminSupabase, {
      ...MOBILE_COMMERCE_RESTORE_RATE_LIMIT,
      key: userId,
    });
    return null;
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return createBackendRateLimitResponse(error);
    }

    dependencies.logError('Mobile commerce restore rate limit check failed:', error);
    return NextResponse.json({ error: 'Failed to check commerce restore limits.' }, { status: 500 });
  }
}

async function handleMobileCommerceRestorePOST(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  try {
    const supabase = dependencies.createUserClient(request);
    const {
      data: { user },
      error: authError,
    } = await getVerifiedAuthUserResult(supabase);

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const adminSupabase = dependencies.createServiceClient();
    const rateLimitResponse = await enforceRestoreRateLimit(adminSupabase, user.id, dependencies);
    if (rateLimitResponse) return rateLimitResponse;

    return NextResponse.json(await dependencies.restoreMobileEntitlements(adminSupabase, user.id));
  } catch (error) {
    if (error instanceof MobileCommerceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    dependencies.logError('Mobile commerce restore failed:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function postMobileCommerceRestoreRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: MobileCommerceRestoreRouteDependencies;
  request: Request;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);
  return resolvedDependencies.withProviderFetchRequestId(getApiRequestId(request), async () => (
    applyPrivateNoStoreApiResponseHeaders(
      await handleMobileCommerceRestorePOST(request, resolvedDependencies),
      request,
    )
  ));
}
