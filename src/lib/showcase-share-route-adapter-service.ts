import 'server-only';
import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { logBackendRouteError } from '@/lib/backend-logger';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import {
  BackendRateLimitError,
  SHOWCASE_SHARE_RATE_LIMIT,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { getClientNetworkKey } from '@/lib/client-network-key';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';
import {
  parseShowcaseSharePayloadForRoute,
  shareShowcasePostForRoute,
} from '@/lib/showcase-share-service';

type ShowcaseShareRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  parseShowcaseSharePayloadForRoute?: typeof parseShowcaseSharePayloadForRoute;
  shareShowcasePostForRoute?: typeof shareShowcasePostForRoute;
  logError?: typeof logBackendRouteError;
};

function resolveDependencies(dependencies: ShowcaseShareRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    enforceBackendRateLimit: dependencies?.enforceBackendRateLimit ?? enforceBackendRateLimit,
    parseShowcaseSharePayloadForRoute: dependencies?.parseShowcaseSharePayloadForRoute
      ?? parseShowcaseSharePayloadForRoute,
    shareShowcasePostForRoute: dependencies?.shareShowcasePostForRoute ?? shareShowcasePostForRoute,
    logError: dependencies?.logError ?? logBackendRouteError,
  };
}

function getShareRateLimitKey(request: Request, userId: string | null) {
  if (userId) return userId;

  return getClientNetworkKey(request.headers);
}

async function getOptionalActorUserId(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  try {
    const supabase = dependencies.createUserClient(request);
    const {
      data: { user },
    } = await getVerifiedAuthUserResult(supabase);

    return user?.id ?? null;
  } catch {
    return null;
  }
}

async function handleShowcaseSharePOST(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  try {
    const payloadResult = dependencies.parseShowcaseSharePayloadForRoute(await request.json());
    if (!payloadResult.ok) {
      return NextResponse.json(payloadResult.body, { status: payloadResult.status });
    }

    const actorUserId = await getOptionalActorUserId(request, dependencies);
    const adminSupabase = dependencies.createServiceClient();

    try {
      await dependencies.enforceBackendRateLimit(adminSupabase, {
        ...SHOWCASE_SHARE_RATE_LIMIT,
        key: getShareRateLimitKey(request, actorUserId),
      });
    } catch (error) {
      if (error instanceof BackendRateLimitError) {
        return createBackendRateLimitResponse(error);
      }

      dependencies.logError('Showcase share rate limit check failed:', error);
      return NextResponse.json({ error: 'Failed to check share limits.' }, { status: 500 });
    }

    const result = await dependencies.shareShowcasePostForRoute({
      actorUserId,
      serviceClient: adminSupabase,
      ...payloadResult.payload,
    });

    return NextResponse.json(result.body, { status: result.ok ? 200 : result.status });
  } catch (error) {
    dependencies.logError('Share tracking error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function postShowcaseShareRouteResponse({
  request,
  dependencies,
}: {
  request: Request;
  dependencies?: ShowcaseShareRouteDependencies;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);
  return applyPrivateNoStoreApiResponseHeaders(
    await handleShowcaseSharePOST(request, resolvedDependencies),
    request,
  );
}
