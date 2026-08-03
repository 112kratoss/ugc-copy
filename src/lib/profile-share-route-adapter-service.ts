import 'server-only';
import { logBackendRouteError } from '@/lib/backend-logger';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import {
  BackendRateLimitError,
  PROFILE_SHARE_RATE_LIMIT,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { getClientNetworkKey } from '@/lib/client-network-key';
import {
  parseProfileSharePayloadForRoute,
  shareCreatorProfileForRoute,
} from '@/lib/profile-share-service';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type ProfileShareRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  parseProfileSharePayloadForRoute?: typeof parseProfileSharePayloadForRoute;
  shareCreatorProfileForRoute?: typeof shareCreatorProfileForRoute;
  logError?: typeof logBackendRouteError;
};

function resolveDependencies(dependencies: ProfileShareRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    enforceBackendRateLimit: dependencies?.enforceBackendRateLimit ?? enforceBackendRateLimit,
    parseProfileSharePayloadForRoute: dependencies?.parseProfileSharePayloadForRoute
      ?? parseProfileSharePayloadForRoute,
    shareCreatorProfileForRoute: dependencies?.shareCreatorProfileForRoute
      ?? shareCreatorProfileForRoute,
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
    } = await supabase.auth.getUser();

    return user?.id ?? null;
  } catch {
    return null;
  }
}

async function handleProfileSharePOST(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  try {
    const payloadResult = dependencies.parseProfileSharePayloadForRoute(await request.json());
    if (!payloadResult.ok) {
      return NextResponse.json(payloadResult.body, { status: payloadResult.status });
    }

    const actorUserId = await getOptionalActorUserId(request, dependencies);
    const adminSupabase = dependencies.createServiceClient();

    try {
      await dependencies.enforceBackendRateLimit(adminSupabase, {
        ...PROFILE_SHARE_RATE_LIMIT,
        key: getShareRateLimitKey(request, actorUserId),
      });
    } catch (error) {
      if (error instanceof BackendRateLimitError) {
        return createBackendRateLimitResponse(error);
      }

      dependencies.logError('Profile share rate limit check failed:', error);
      return NextResponse.json({ error: 'Failed to check share limits.' }, { status: 500 });
    }

    const result = await dependencies.shareCreatorProfileForRoute({
      actorUserId,
      serviceClient: adminSupabase,
      ...payloadResult.payload,
    });

    return NextResponse.json(result.body, { status: result.ok ? 200 : result.status });
  } catch (error) {
    dependencies.logError('Profile share tracking error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function postProfileShareRouteResponse({
  request,
  dependencies,
}: {
  request: Request;
  dependencies?: ProfileShareRouteDependencies;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);
  return applyPrivateNoStoreApiResponseHeaders(
    await handleProfileSharePOST(request, resolvedDependencies),
    request,
  );
}
