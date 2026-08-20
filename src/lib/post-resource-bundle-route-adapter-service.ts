import 'server-only';
import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { createBackendRateLimitResponse } from '@/lib/backend-rate-limit';
import {
  getPostResourceBundleForRoute,
  type PostResourceBundleRouteResult,
} from '@/lib/post-resource-bundle-route-service';
import { createUserClient } from '@/lib/server-helpers';

type PostResourceBundleRouteContext = {
  params: Promise<{ postId: string }>;
};

type PostResourceBundleRouteAdapterDependencies = {
  createUserClient?: typeof createUserClient;
  getPostResourceBundleForRoute?: typeof getPostResourceBundleForRoute;
};

function resolveDependencies(dependencies: PostResourceBundleRouteAdapterDependencies | undefined) {
  return {
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    getPostResourceBundleForRoute:
      dependencies?.getPostResourceBundleForRoute ?? getPostResourceBundleForRoute,
  };
}

function toJsonResponse(result: PostResourceBundleRouteResult) {
  if (!result.ok && 'rateLimitError' in result) {
    return createBackendRateLimitResponse(result.rateLimitError);
  }

  return NextResponse.json(result.body, { status: result.ok ? 200 : result.status });
}

async function handleResourceBundleGET(
  request: Request,
  context: PostResourceBundleRouteContext,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const { postId } = await context.params;
  const supabase = dependencies.createUserClient(request);
  const {
    data: { user },
  } = await getVerifiedAuthUserResult(supabase);

  return toJsonResponse(await dependencies.getPostResourceBundleForRoute({
    postId,
    viewerUserId: user?.id ?? null,
    countryCode: request.headers.get('x-vercel-ip-country'),
  }));
}

export async function getPostResourceBundleRouteResponse({
  context,
  dependencies,
  request,
}: {
  context: PostResourceBundleRouteContext;
  dependencies?: PostResourceBundleRouteAdapterDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handleResourceBundleGET(request, context, resolveDependencies(dependencies)),
    request,
  );
}

export function createPostResourceBundleRouteHandlers({
  dependencies,
}: {
  dependencies?: PostResourceBundleRouteAdapterDependencies;
} = {}) {
  return {
    GET(request: Request, context: PostResourceBundleRouteContext) {
      return getPostResourceBundleRouteResponse({ context, dependencies, request });
    },
  };
}
