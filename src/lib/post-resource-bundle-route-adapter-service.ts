import 'server-only';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { createBackendRateLimitResponse } from '@/lib/backend-rate-limit';
import {
  getPostResourceBundleForRoute,
  putPostResourceBundleForRoute,
  type PostResourceBundleRouteResult,
} from '@/lib/post-resource-bundle-route-service';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type PostResourceBundleRouteContext = {
  params: Promise<{ postId: string }>;
};

type PostResourceBundleRouteAdapterDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  getPostResourceBundleForRoute?: typeof getPostResourceBundleForRoute;
  putPostResourceBundleForRoute?: typeof putPostResourceBundleForRoute;
};

function resolveDependencies(dependencies: PostResourceBundleRouteAdapterDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    getPostResourceBundleForRoute:
      dependencies?.getPostResourceBundleForRoute ?? getPostResourceBundleForRoute,
    putPostResourceBundleForRoute:
      dependencies?.putPostResourceBundleForRoute ?? putPostResourceBundleForRoute,
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
  } = await supabase.auth.getUser();

  return toJsonResponse(await dependencies.getPostResourceBundleForRoute({
    postId,
    viewerUserId: user?.id ?? null,
    countryCode: request.headers.get('x-vercel-ip-country'),
  }));
}

async function handleResourceBundlePUT(
  request: Request,
  context: PostResourceBundleRouteContext,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const { postId } = await context.params;
  const supabase = dependencies.createUserClient(request);
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const adminSupabase = dependencies.createServiceClient();
  return toJsonResponse(await dependencies.putPostResourceBundleForRoute({
    postId,
    ownerUserId: user.id,
    userSupabase: supabase,
    adminSupabase,
    readBody: () => request.json(),
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

export async function putPostResourceBundleRouteResponse({
  context,
  dependencies,
  request,
}: {
  context: PostResourceBundleRouteContext;
  dependencies?: PostResourceBundleRouteAdapterDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handleResourceBundlePUT(request, context, resolveDependencies(dependencies)),
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
    PUT(request: Request, context: PostResourceBundleRouteContext) {
      return putPostResourceBundleRouteResponse({ context, dependencies, request });
    },
  };
}
