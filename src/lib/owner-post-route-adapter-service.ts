import 'server-only';
import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { createBackendRateLimitResponse } from '@/lib/backend-rate-limit';
import {
  deleteOwnerPostRoute,
  getOwnerPostDetailForRoute,
  updateOwnerPostRoute,
  type OwnerPostDetailRouteResult,
  type OwnerPostMutationRouteResult,
} from '@/lib/owner-post-route-service';

type RouteContext = {
  params: Promise<{ postId: string }>;
};

type OwnerPostRouteAdapterDependencies = {
  deleteOwnerPostRoute?: typeof deleteOwnerPostRoute;
  getOwnerPostDetailForRoute?: typeof getOwnerPostDetailForRoute;
  updateOwnerPostRoute?: typeof updateOwnerPostRoute;
  /** Deprecated test seams: the leased queue exclusively owns media repair. */
  createServiceClient?: () => unknown;
  repairMediaForPost?: (...args: never[]) => Promise<unknown>;
  schedulePostMediaRepair?: (callback: () => Promise<void>) => void;
};

function resolveDependencies(dependencies: OwnerPostRouteAdapterDependencies | undefined) {
  return {
    deleteOwnerPostRoute: dependencies?.deleteOwnerPostRoute ?? deleteOwnerPostRoute,
    getOwnerPostDetailForRoute: dependencies?.getOwnerPostDetailForRoute ?? getOwnerPostDetailForRoute,
    updateOwnerPostRoute: dependencies?.updateOwnerPostRoute ?? updateOwnerPostRoute,
  };
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
