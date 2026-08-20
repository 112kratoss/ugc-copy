import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { isGuestUser } from '@/lib/account-identity';
import 'server-only';
import { logBackendRouteError } from '@/lib/backend-logger';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders, getApiRequestId } from '@/lib/api-cache';
import {
  BackendRateLimitError,
  SHOWCASE_PUBLISH_RATE_LIMIT,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import {
  fetchWithProviderTimeout,
  withProviderFetchRequestId,
} from '@/lib/provider-fetch';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';
import {
  publishGenerationToShowcaseForRoute,
  type ShowcasePublishRequestBody,
} from '@/lib/showcase-publish-service';

type ShowcasePublishRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  fetchWithProviderTimeout?: typeof fetchWithProviderTimeout;
  logError?: typeof logBackendRouteError;
  publishGenerationToShowcaseForRoute?: typeof publishGenerationToShowcaseForRoute;
  /** Deprecated test seam. Repair is now exclusively queue/cron owned. */
  repairMediaForPost?: (...args: never[]) => Promise<unknown>;
  /** Deprecated test seam. Publish never starts media work in after(). */
  schedulePostMediaRepair?: (callback: () => Promise<void>) => void;
  withProviderFetchRequestId?: typeof withProviderFetchRequestId;
};

function resolveDependencies(dependencies: ShowcasePublishRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    enforceBackendRateLimit: dependencies?.enforceBackendRateLimit ?? enforceBackendRateLimit,
    fetchWithProviderTimeout: dependencies?.fetchWithProviderTimeout ?? fetchWithProviderTimeout,
    logError: dependencies?.logError ?? logBackendRouteError,
    publishGenerationToShowcaseForRoute:
      dependencies?.publishGenerationToShowcaseForRoute ?? publishGenerationToShowcaseForRoute,
    withProviderFetchRequestId: dependencies?.withProviderFetchRequestId ?? withProviderFetchRequestId,
  };
}

async function getAuthenticatedUserId(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const supabase = dependencies.createUserClient(request);
  const {
    data: { user },
    error: authError,
  } = await getVerifiedAuthUserResult(supabase);

  return authError || !user || isGuestUser(user)
    ? { ok: false as const }
    : { ok: true as const, supabase, userId: user.id };
}

async function handleShowcasePublishPOST(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  try {
    const auth = await getAuthenticatedUserId(request, dependencies);
    if (!auth.ok) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const adminSupabase = dependencies.createServiceClient();
    try {
      await dependencies.enforceBackendRateLimit(adminSupabase, {
        ...SHOWCASE_PUBLISH_RATE_LIMIT,
        key: auth.userId,
      });
    } catch (error) {
      if (error instanceof BackendRateLimitError) {
        return createBackendRateLimitResponse(error);
      }

      dependencies.logError('Showcase publish rate limit check failed:', error);
      return NextResponse.json({ error: 'Failed to check showcase publish limits.' }, { status: 500 });
    }

    const requestBody = await request.json() as Partial<ShowcasePublishRequestBody>;
    if (!requestBody.generationId) {
      return NextResponse.json({ error: 'Missing generation ID' }, { status: 400 });
    }

    const result = await dependencies.publishGenerationToShowcaseForRoute({
      adminSupabase,
      body: requestBody as ShowcasePublishRequestBody,
      dependencies: {
        fetchWithProviderTimeout: dependencies.fetchWithProviderTimeout,
      },
      userId: auth.userId,
    });

    if (!result.ok) {
      return NextResponse.json(result.body, { status: result.status });
    }

    return NextResponse.json(result.body);
  } catch (error) {
    dependencies.logError('Publish error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function postShowcasePublishRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: ShowcasePublishRouteDependencies;
  request: Request;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);
  return resolvedDependencies.withProviderFetchRequestId(getApiRequestId(request), async () => (
    applyPrivateNoStoreApiResponseHeaders(
      await handleShowcasePublishPOST(request, resolvedDependencies),
      request,
    )
  ));
}
