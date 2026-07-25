import 'server-only';
import { logBackendRouteError } from '@/lib/backend-logger';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import {
  BackendRateLimitError,
  SHOWCASE_SAVE_RATE_LIMIT,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';
import { saveShowcasePostForRoute } from '@/lib/showcase-save-service';

type ShowcaseSaveRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  logError?: typeof logBackendRouteError;
  saveShowcasePostForRoute?: typeof saveShowcasePostForRoute;
};

function resolveDependencies(dependencies: ShowcaseSaveRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    enforceBackendRateLimit: dependencies?.enforceBackendRateLimit ?? enforceBackendRateLimit,
    logError: dependencies?.logError ?? logBackendRouteError,
    saveShowcasePostForRoute: dependencies?.saveShowcasePostForRoute ?? saveShowcasePostForRoute,
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
  } = await supabase.auth.getUser();

  return authError || !user ? null : user.id;
}

async function handleShowcaseSavePOST(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  try {
    const userId = await getAuthenticatedUserId(request, dependencies);
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const serviceClient = dependencies.createServiceClient();
    try {
      await dependencies.enforceBackendRateLimit(serviceClient, {
        ...SHOWCASE_SAVE_RATE_LIMIT,
        key: userId,
      });
    } catch (error) {
      if (error instanceof BackendRateLimitError) {
        return createBackendRateLimitResponse(error);
      }

      dependencies.logError('Failed to enforce showcase save rate limit:', error);
      return NextResponse.json({ error: 'Failed to update save status' }, { status: 500 });
    }

    const { generationId, postId, shouldSave, sourceSurface } = await request.json();
    const referenceId = typeof postId === 'string' ? postId : generationId;
    const requestedSaveState = typeof shouldSave === 'boolean' ? shouldSave : null;
    const hasTargetSaveState = requestedSaveState !== null;

    if (!referenceId || typeof referenceId !== 'string') {
      return NextResponse.json({ error: 'Missing post ID' }, { status: 400 });
    }

    if (shouldSave !== undefined && !hasTargetSaveState) {
      return NextResponse.json({ error: 'Invalid save state' }, { status: 400 });
    }

    const result = await dependencies.saveShowcasePostForRoute({
      actorUserId: userId,
      referenceId,
      requestedSaveState,
      serviceClient,
      sourceSurface,
    });

    if (!result.ok) {
      return NextResponse.json(result.body, { status: result.status });
    }

    return NextResponse.json(result.body);
  } catch (error) {
    dependencies.logError('Save error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function postShowcaseSaveRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: ShowcaseSaveRouteDependencies;
  request: Request;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);
  return applyPrivateNoStoreApiResponseHeaders(
    await handleShowcaseSavePOST(request, resolvedDependencies),
    request,
  );
}
