import 'server-only';
import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';

import { NextResponse } from 'next/server';

import {
  API_CACHE_CONTROL,
  applyApiResponseHeaders,
  getViewerAwareApiCacheControl,
} from '@/lib/api-cache';
import { createBackendRateLimitResponse } from '@/lib/backend-rate-limit';
import { isMarketplaceCreatorBlockedForViewer } from '@/lib/marketplace-viewer-filter';
import {
  getPostResourceBundleForRoute,
  type PostResourceBundleRouteResult,
} from '@/lib/post-resource-bundle-route-service';
import { getPostResourceBundleDetailByPostId } from '@/lib/post-resource-bundles-server';
import { createUserClient } from '@/lib/server-helpers';

type PostResourceBundleRouteContext = {
  params: Promise<{ postId: string }>;
};

type PostResourceBundleRouteAdapterDependencies = {
  createUserClient?: typeof createUserClient;
  getPostResourceBundleDetailByPostId?: typeof getPostResourceBundleDetailByPostId;
  getPostResourceBundleForRoute?: typeof getPostResourceBundleForRoute;
  isMarketplaceCreatorBlockedForViewer?: typeof isMarketplaceCreatorBlockedForViewer;
};

function resolveDependencies(dependencies: PostResourceBundleRouteAdapterDependencies | undefined) {
  return {
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    getPostResourceBundleDetailByPostId:
      dependencies?.getPostResourceBundleDetailByPostId ?? getPostResourceBundleDetailByPostId,
    getPostResourceBundleForRoute:
      dependencies?.getPostResourceBundleForRoute ?? getPostResourceBundleForRoute,
    isMarketplaceCreatorBlockedForViewer:
      dependencies?.isMarketplaceCreatorBlockedForViewer ?? isMarketplaceCreatorBlockedForViewer,
  };
}

function toJsonResponse(result: PostResourceBundleRouteResult) {
  if (!result.ok && 'rateLimitError' in result) {
    return createBackendRateLimitResponse(result.rateLimitError);
  }

  return NextResponse.json(result.body, { status: result.ok ? 200 : result.status });
}

/** Only a bearer names a viewer here: `createUserClient` reads no cookie. */
async function getViewerUserId(
  request: Request,
  hasAuthorizationHeader: boolean,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  if (!hasAuthorizationHeader) return null;

  const supabase = dependencies.createUserClient(request);
  const {
    data: { user },
  } = await getVerifiedAuthUserResult(supabase);
  return user?.id ?? null;
}

async function handleResourceBundleGET(
  request: Request,
  context: PostResourceBundleRouteContext,
  dependencies: ReturnType<typeof resolveDependencies>,
  hasAuthorizationHeader: boolean,
) {
  const { postId } = await context.params;
  const viewerUserId = await getViewerUserId(request, hasAuthorizationHeader, dependencies);

  return toJsonResponse(await dependencies.getPostResourceBundleForRoute({
    postId,
    viewerUserId,
    countryCode: request.headers.get('x-vercel-ip-country'),
    // Across a block either way the bundle is answered as missing, as the post
    // page and the marketplace detail answer.
    getDetailByPostId: async (detailPostId, options) => {
      const detail = await dependencies.getPostResourceBundleDetailByPostId(detailPostId, options);
      return detail
        && viewerUserId
        && await dependencies.isMarketplaceCreatorBlockedForViewer(viewerUserId, detail.seller.id)
        ? null
        : detail;
    },
  }));
}

/**
 * A visitor's answer (no bearer) is the recipe as any signed-out visitor in
 * their country reads it, so the edge keeps one copy per country for a minute,
 * as it does the marketplace listing's: the post page asks it for every
 * visitor who opens a cash-priced recipe, to price it in their currency. Every
 * answer read with a bearer is that viewer's (bought, owned, across a block),
 * and is never stored anywhere; nor is a refusal or an error.
 */
export async function getPostResourceBundleRouteResponse({
  context,
  dependencies,
  request,
}: {
  context: PostResourceBundleRouteContext;
  dependencies?: PostResourceBundleRouteAdapterDependencies;
  request: Request;
}) {
  const hasAuthorizationHeader = Boolean(request.headers.get('Authorization'));
  const response = await handleResourceBundleGET(
    request,
    context,
    resolveDependencies(dependencies),
    hasAuthorizationHeader,
  );
  return applyApiResponseHeaders(
    response,
    request,
    response.status === 200 ? getViewerAwareApiCacheControl(hasAuthorizationHeader) : API_CACHE_CONTROL.privateNoStore,
    { vary: ['Authorization', 'x-vercel-ip-country'] },
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
