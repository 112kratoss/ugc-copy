import 'server-only';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import {
  BackendRateLimitError,
  SHOWCASE_REMIX_RATE_LIMIT,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';
import { remixShowcasePostForRoute } from '@/lib/showcase-remix-service';

type ShowcaseRemixRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  logError?: typeof console.error;
  remixShowcasePostForRoute?: typeof remixShowcasePostForRoute;
};

function resolveDependencies(dependencies: ShowcaseRemixRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    enforceBackendRateLimit: dependencies?.enforceBackendRateLimit ?? enforceBackendRateLimit,
    logError: dependencies?.logError ?? console.error,
    remixShowcasePostForRoute: dependencies?.remixShowcasePostForRoute ?? remixShowcasePostForRoute,
  };
}

async function handleShowcaseRemixPOST(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  try {
    const supabase = dependencies.createUserClient(request);
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized: Please log in to remix creations' }, { status: 401 });
    }

    const adminSupabase = dependencies.createServiceClient();
    try {
      await dependencies.enforceBackendRateLimit(adminSupabase, {
        ...SHOWCASE_REMIX_RATE_LIMIT,
        key: user.id,
      });
    } catch (error) {
      if (error instanceof BackendRateLimitError) {
        return createBackendRateLimitResponse(error);
      }

      dependencies.logError('Failed to enforce showcase remix rate limit:', error);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

    const { generationId, postId } = await request.json() as { generationId?: unknown; postId?: unknown };
    const referenceId = typeof postId === 'string' ? postId : generationId;

    if (!referenceId || typeof referenceId !== 'string') {
      return NextResponse.json({ error: 'Missing post ID' }, { status: 400 });
    }

    const result = await dependencies.remixShowcasePostForRoute({
      actorUserId: user.id,
      referenceId,
      serviceClient: adminSupabase,
      userClient: supabase,
    });

    if (!result.ok) {
      return NextResponse.json(result.body, { status: result.status });
    }

    return NextResponse.json(result.body);
  } catch (error) {
    dependencies.logError('Remix error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function postShowcaseRemixRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: ShowcaseRemixRouteDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handleShowcaseRemixPOST(request, resolveDependencies(dependencies)),
    request,
  );
}
