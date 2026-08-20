import 'server-only';
import { logBackendRouteError } from '@/lib/backend-logger';

import { NextResponse } from 'next/server';

import { requireIdentity } from '@/lib/account-identity';
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
  requireIdentity?: typeof requireIdentity;
  restoreGenerationMediaForRoute?: typeof restoreGenerationMediaForRoute;
};

function resolveDependencies(dependencies: GenerationRestoreMediaRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    enforceBackendRateLimit: dependencies?.enforceBackendRateLimit ?? enforceBackendRateLimit,
    logError: dependencies?.logError ?? logBackendRouteError,
    requireIdentity: dependencies?.requireIdentity ?? requireIdentity,
    restoreGenerationMediaForRoute:
      dependencies?.restoreGenerationMediaForRoute ?? restoreGenerationMediaForRoute,
  };
}

async function handleGenerationRestoreMediaPOST(
  request: Request,
  context: GenerationRestoreMediaRouteContext,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const { id } = await context.params;
  const userSupabase = dependencies.createUserClient(request);
  let adminSupabase: ReturnType<typeof dependencies.createServiceClient> | null = null;
  const getAdminSupabase = () => {
    adminSupabase ??= dependencies.createServiceClient();
    return adminSupabase;
  };
  const identity = await dependencies.requireIdentity(userSupabase, getAdminSupabase);
  if (!identity.ok) {
    return NextResponse.json(
      { error: identity.error, code: identity.code },
      { status: identity.status },
    );
  }
  const userId = identity.identity.userId;

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

  const admin = getAdminSupabase();
  try {
    await dependencies.enforceBackendRateLimit(admin, {
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
    adminSupabase: admin,
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
