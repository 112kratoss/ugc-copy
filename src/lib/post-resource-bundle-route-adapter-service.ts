import 'server-only';
import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
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
  const viewerUserId = user?.id ?? null;

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
