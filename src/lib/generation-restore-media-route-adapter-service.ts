import 'server-only';
import { logBackendRouteError } from '@/lib/backend-logger';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import {
  BackendRateLimitError,
  GENERATION_LIFECYCLE_MUTATION_RATE_LIMIT,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { restoreGenerationMediaForRoute } from '@/lib/generation-restore-media-service';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

export type GenerationRestoreMediaRouteContext = {
  params: Promise<{ id: string }>;
};

type GenerationRestoreMediaRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  logError?: typeof logBackendRouteError;
  restoreGenerationMediaForRoute?: typeof restoreGenerationMediaForRoute;
};

function resolveDependencies(dependencies: GenerationRestoreMediaRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    enforceBackendRateLimit: dependencies?.enforceBackendRateLimit ?? enforceBackendRateLimit,
    logError: dependencies?.logError ?? logBackendRouteError,
    restoreGenerationMediaForRoute:
      dependencies?.restoreGenerationMediaForRoute ?? restoreGenerationMediaForRoute,
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

async function handleGenerationRestoreMediaPOST(
  request: Request,
  context: GenerationRestoreMediaRouteContext,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const { id } = await context.params;
  const userId = await getAuthenticatedUserId(request, dependencies);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let requestBody: {
    storagePath?: unknown;
    originalName?: unknown;
    contentType?: unknown;
  };
  try {
    requestBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid restore request.' }, { status: 400 });
  }

  const adminSupabase = dependencies.createServiceClient();
  try {
    await dependencies.enforceBackendRateLimit(adminSupabase, {
      ...GENERATION_LIFECYCLE_MUTATION_RATE_LIMIT,
      key: userId,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return createBackendRateLimitResponse(error);
    }

    dependencies.logError('Failed to enforce generation media restore rate limit:', error);
    return NextResponse.json({ error: 'Failed to restore preview.' }, { status: 500 });
  }

  const result = await dependencies.restoreGenerationMediaForRoute({
    adminSupabase,
    body: requestBody,
    generationId: id,
    userId,
  });

  if (!result.ok) {
    return NextResponse.json(result.body, { status: result.status });
  }

  return NextResponse.json(result.body);
}

export async function postGenerationRestoreMediaRouteResponse({
  context,
  dependencies,
  request,
}: {
  context: GenerationRestoreMediaRouteContext;
  dependencies?: GenerationRestoreMediaRouteDependencies;
  request: Request;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);
  return applyPrivateNoStoreApiResponseHeaders(
    await handleGenerationRestoreMediaPOST(request, context, resolvedDependencies),
    request,
  );
}
