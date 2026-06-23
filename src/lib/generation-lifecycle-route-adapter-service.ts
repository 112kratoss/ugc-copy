import 'server-only';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { createBackendRateLimitResponse } from '@/lib/backend-rate-limit';
import {
  deleteOwnerGenerationForRoute,
  type GenerationDeleteRouteResult,
} from '@/lib/generation-delete-service';
import {
  archiveOwnerGenerationForRoute,
  restoreOwnerGenerationForRoute,
  type GenerationLifecycleResult,
} from '@/lib/generation-lifecycle-service';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type GenerationLifecycleAction = 'archive' | 'restore';

type GenerationLifecycleRouteDependencies = {
  archiveOwnerGenerationForRoute?: typeof archiveOwnerGenerationForRoute;
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  deleteOwnerGenerationForRoute?: typeof deleteOwnerGenerationForRoute;
  logError?: typeof console.error;
  restoreOwnerGenerationForRoute?: typeof restoreOwnerGenerationForRoute;
};

function resolveDependencies(dependencies: GenerationLifecycleRouteDependencies | undefined) {
  return {
    archiveOwnerGenerationForRoute:
      dependencies?.archiveOwnerGenerationForRoute ?? archiveOwnerGenerationForRoute,
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    deleteOwnerGenerationForRoute:
      dependencies?.deleteOwnerGenerationForRoute ?? deleteOwnerGenerationForRoute,
    logError: dependencies?.logError ?? console.error,
    restoreOwnerGenerationForRoute:
      dependencies?.restoreOwnerGenerationForRoute ?? restoreOwnerGenerationForRoute,
  };
}

function toJsonResponse(result: GenerationLifecycleResult | GenerationDeleteRouteResult) {
  if (result.ok) {
    return NextResponse.json(result.body);
  }

  if ('rateLimitError' in result && result.rateLimitError) {
    return createBackendRateLimitResponse(result.rateLimitError);
  }

  if ('body' in result && 'status' in result) {
    return NextResponse.json(result.body, { status: result.status });
  }

  return createBackendRateLimitResponse(result.rateLimitError);
}

function getFailureMessage(action: GenerationLifecycleAction) {
  return action === 'archive' ? 'Failed to archive creation.' : 'Failed to restore creation.';
}

function getLogMessage(action: GenerationLifecycleAction) {
  return action === 'archive'
    ? 'Failed to archive owner generation:'
    : 'Failed to restore owner generation:';
}

async function handleGenerationLifecyclePOST({
  action,
  dependencies,
  generationId,
  request,
}: {
  action: GenerationLifecycleAction;
  dependencies: ReturnType<typeof resolveDependencies>;
  generationId: string;
  request: Request;
}) {
  const supabase = dependencies.createUserClient(request);
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const serviceInput = {
      adminSupabase: dependencies.createServiceClient(),
      generationId,
      ownerUserId: user.id,
    };
    const result = action === 'archive'
      ? await dependencies.archiveOwnerGenerationForRoute(serviceInput)
      : await dependencies.restoreOwnerGenerationForRoute(serviceInput);

    return toJsonResponse(result);
  } catch (error) {
    dependencies.logError(getLogMessage(action), error);
    return NextResponse.json({ error: getFailureMessage(action) }, { status: 500 });
  }
}

async function generationLifecycleRouteResponse({
  action,
  dependencies,
  generationId,
  request,
}: {
  action: GenerationLifecycleAction;
  dependencies?: GenerationLifecycleRouteDependencies;
  generationId: string;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handleGenerationLifecyclePOST({
      action,
      dependencies: resolveDependencies(dependencies),
      generationId,
      request,
    }),
    request,
  );
}

export function generationArchiveRouteResponse({
  dependencies,
  generationId,
  request,
}: {
  dependencies?: GenerationLifecycleRouteDependencies;
  generationId: string;
  request: Request;
}) {
  return generationLifecycleRouteResponse({
    action: 'archive',
    dependencies,
    generationId,
    request,
  });
}

export function generationRestoreRouteResponse({
  dependencies,
  generationId,
  request,
}: {
  dependencies?: GenerationLifecycleRouteDependencies;
  generationId: string;
  request: Request;
}) {
  return generationLifecycleRouteResponse({
    action: 'restore',
    dependencies,
    generationId,
    request,
  });
}

export async function generationDeleteRouteResponse({
  dependencies,
  generationId,
  request,
}: {
  dependencies?: GenerationLifecycleRouteDependencies;
  generationId: string;
  request: Request;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);

  return applyPrivateNoStoreApiResponseHeaders(
    toJsonResponse(await resolvedDependencies.deleteOwnerGenerationForRoute({
      request,
      generationId,
      createUserSupabase: () => resolvedDependencies.createUserClient(request),
      createAdminSupabase: resolvedDependencies.createServiceClient,
    })),
    request,
  );
}
