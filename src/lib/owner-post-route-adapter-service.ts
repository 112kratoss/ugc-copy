import 'server-only';
import { logBackendWarning } from '@/lib/backend-logger';

import { NextResponse, after } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { createBackendRateLimitResponse } from '@/lib/backend-rate-limit';
import {
  deleteOwnerPostRoute,
  getOwnerPostDetailForRoute,
  updateOwnerPostRoute,
  type OwnerPostDetailRouteResult,
  type OwnerPostMutationRouteResult,
} from '@/lib/owner-post-route-service';
import { repairMediaForPost } from '@/lib/media-preview-repair';
import { createServiceClient } from '@/lib/server-helpers';

type RouteContext = {
  params: Promise<{ postId: string }>;
};

type OwnerPostRouteAdapterDependencies = {
  deleteOwnerPostRoute?: typeof deleteOwnerPostRoute;
  getOwnerPostDetailForRoute?: typeof getOwnerPostDetailForRoute;
  updateOwnerPostRoute?: typeof updateOwnerPostRoute;
  createServiceClient?: typeof createServiceClient;
  repairMediaForPost?: typeof repairMediaForPost;
  /** Seam over `after` so tests can drive the post-response work directly. */
  schedulePostMediaRepair?: (callback: () => Promise<void>) => void;
};

function resolveDependencies(dependencies: OwnerPostRouteAdapterDependencies | undefined) {
  return {
    deleteOwnerPostRoute: dependencies?.deleteOwnerPostRoute ?? deleteOwnerPostRoute,
    getOwnerPostDetailForRoute: dependencies?.getOwnerPostDetailForRoute ?? getOwnerPostDetailForRoute,
    updateOwnerPostRoute: dependencies?.updateOwnerPostRoute ?? updateOwnerPostRoute,
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    repairMediaForPost: dependencies?.repairMediaForPost ?? repairMediaForPost,
    schedulePostMediaRepair: dependencies?.schedulePostMediaRepair
      ?? ((callback: () => Promise<void>) => after(callback)),
  };
}

/**
 * Kick the deferred preview and rendition work for a post that just changed.
 *
 * Editing defers the same work publishing does, so without this a swapped-in
 * video would carry a placeholder until the hourly sweep reached it. Every
 * failure is swallowed: the edit is already saved and the sweep repairs exactly
 * this work, so neither a scheduling nor a repair failure may turn a successful
 * edit into an error.
 */
function schedulePostMediaRepairForPost(
  postId: string,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  try {
    dependencies.schedulePostMediaRepair(async () => {
      try {
        // Created inside the callback, not beside it: the update service owns
        // the client the request itself uses, so building one here would add a
        // second per request even when there is no media work to do.
        await dependencies.repairMediaForPost(dependencies.createServiceClient(), postId);
      } catch (error) {
        logBackendWarning('post_media_async_repair_failed', { error, postId });
      }
    });
  } catch (error) {
    logBackendWarning('post_media_async_repair_not_scheduled', { error, postId });
  }
}

function ownerPostJsonResponse(result: OwnerPostDetailRouteResult | OwnerPostMutationRouteResult) {
  if (!result.ok) {
    if ('rateLimitError' in result && result.rateLimitError) {
      return createBackendRateLimitResponse(result.rateLimitError);
    }

    return NextResponse.json(result.body, { status: result.status });
  }

  return NextResponse.json(result.body);
}

async function handleOwnerPostGET(
  request: Request,
  context: RouteContext,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const { postId } = await context.params;
  return ownerPostJsonResponse(await dependencies.getOwnerPostDetailForRoute({ request, postId }));
}

async function handleOwnerPostPUT(
  request: Request,
  context: RouteContext,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const { postId } = await context.params;
  const result = await dependencies.updateOwnerPostRoute({ request, postId });

  if (result.ok) {
    schedulePostMediaRepairForPost(postId, dependencies);
  }

  return ownerPostJsonResponse(result);
}

async function handleOwnerPostDELETE(
  request: Request,
  context: RouteContext,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const { postId } = await context.params;
  return ownerPostJsonResponse(await dependencies.deleteOwnerPostRoute({ request, postId }));
}

export async function getOwnerPostRouteResponse({
  context,
  dependencies,
  request,
}: {
  context: RouteContext;
  dependencies?: OwnerPostRouteAdapterDependencies;
  request: Request;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);
  return applyPrivateNoStoreApiResponseHeaders(
    await handleOwnerPostGET(request, context, resolvedDependencies),
    request,
  );
}

export async function putOwnerPostRouteResponse({
  context,
  dependencies,
  request,
}: {
  context: RouteContext;
  dependencies?: OwnerPostRouteAdapterDependencies;
  request: Request;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);
  return applyPrivateNoStoreApiResponseHeaders(
    await handleOwnerPostPUT(request, context, resolvedDependencies),
    request,
  );
}

export async function patchOwnerPostRouteResponse({
  context,
  dependencies,
  request,
}: {
  context: RouteContext;
  dependencies?: OwnerPostRouteAdapterDependencies;
  request: Request;
}) {
  return putOwnerPostRouteResponse({ context, dependencies, request });
}

export async function deleteOwnerPostRouteResponse({
  context,
  dependencies,
  request,
}: {
  context: RouteContext;
  dependencies?: OwnerPostRouteAdapterDependencies;
  request: Request;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);
  return applyPrivateNoStoreApiResponseHeaders(
    await handleOwnerPostDELETE(request, context, resolvedDependencies),
    request,
  );
}

export function createOwnerPostRouteHandlers({
  dependencies,
}: {
  dependencies?: OwnerPostRouteAdapterDependencies;
} = {}) {
  return {
    DELETE(request: Request, context: RouteContext) {
      return deleteOwnerPostRouteResponse({ context, dependencies, request });
    },
    GET(request: Request, context: RouteContext) {
      return getOwnerPostRouteResponse({ context, dependencies, request });
    },
    PATCH(request: Request, context: RouteContext) {
      return patchOwnerPostRouteResponse({ context, dependencies, request });
    },
    PUT(request: Request, context: RouteContext) {
      return putOwnerPostRouteResponse({ context, dependencies, request });
    },
  };
}
