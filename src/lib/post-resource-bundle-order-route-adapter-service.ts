import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { isGuestUser } from '@/lib/account-identity';
import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders, getApiRequestId } from '@/lib/api-cache';
import { createBackendRateLimitResponse } from '@/lib/backend-rate-limit';
import {
  createPostResourceBundleOrderForRoute,
  type PostResourceBundleOrderRouteResult,
} from '@/lib/post-resource-bundle-order-service';
import { withProviderFetchRequestId } from '@/lib/provider-fetch';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type RouteContext = {
  params: Promise<{ postId: string }>;
};

type PostResourceBundleOrderRouteDependencies = {
  createPostResourceBundleOrderForRoute?: typeof createPostResourceBundleOrderForRoute;
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  withProviderFetchRequestId?: typeof withProviderFetchRequestId;
};

function resolveDependencies(dependencies: PostResourceBundleOrderRouteDependencies | undefined) {
  return {
    createPostResourceBundleOrderForRoute:
      dependencies?.createPostResourceBundleOrderForRoute ?? createPostResourceBundleOrderForRoute,
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    withProviderFetchRequestId:
      dependencies?.withProviderFetchRequestId ?? withProviderFetchRequestId,
  };
}

function toJsonResponse(result: PostResourceBundleOrderRouteResult) {
  if (!result.ok && result.rateLimitError) {
    return createBackendRateLimitResponse(result.rateLimitError);
  }

  if (!result.ok) {
    return NextResponse.json(result.body, { status: result.status });
  }

  return NextResponse.json(result.body);
}

async function handlePostResourceBundleOrderPOST(
  request: Request,
  context: RouteContext,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const { postId } = await context.params;
  const supabase = dependencies.createUserClient(request) as SupabaseClient;
  const {
    data: { user },
    error: authError,
  } = await getVerifiedAuthUserResult(supabase);

  // Registered-only per route-identity-policy.ts. A guest holds a valid
    // JWT, so `!user` alone stopped meaning "not registered" the moment
    // anonymous sessions existed.
    if (authError || !user || isGuestUser(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return toJsonResponse(await dependencies.createPostResourceBundleOrderForRoute({
    adminSupabase: dependencies.createServiceClient(),
    postId,
    buyerUserId: user.id,
    countryHeader: request.headers.get('x-vercel-ip-country'),
    readBody: () => request.json(),
  }));
}

export async function postPostResourceBundleOrderRouteResponse({
  context,
  dependencies,
  request,
}: {
  context: RouteContext;
  dependencies?: PostResourceBundleOrderRouteDependencies;
  request: Request;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);

  return resolvedDependencies.withProviderFetchRequestId(getApiRequestId(request), async () => (
    applyPrivateNoStoreApiResponseHeaders(
      await handlePostResourceBundleOrderPOST(request, context, resolvedDependencies),
      request,
    )
  ));
}
