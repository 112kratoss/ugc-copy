import 'server-only';

import { NextResponse } from 'next/server';

import {
  createApiResponseHeaders,
  getApiRequestId,
  getViewerAwareApiCacheControl,
} from '@/lib/api-cache';
import { logBackendRouteError } from '@/lib/backend-logger';
import {
  BackendRateLimitError,
  SHOWCASE_POST_REMIXES_READ_RATE_LIMIT,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import {
  listPostRemixes,
  normalizePostRemixesLimit,
  normalizePostRemixesOffset,
} from '@/lib/post-remixes-service';
import { withProviderFetchRequestId } from '@/lib/provider-fetch';
import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';
import { getFeedNetworkKeyHash } from '@/lib/showcase-feed-identity';

/**
 * GET /api/showcase/posts/:postId/remixes?offset=&limit= — a post's posted
 * remixes (`post-remixes-service.ts`). Public, as the post read by id is: a
 * token only leaves out whom its viewer is blocked with and keys the rate limit
 * on them; a signed-out caller is keyed on a salted network hash.
 */

export type PostRemixesRouteContext = {
  params: Promise<{ postId: string }>;
};

type PostRemixesRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  getFeedNetworkKeyHash?: typeof getFeedNetworkKeyHash;
  listPostRemixes?: typeof listPostRemixes;
  logError?: typeof logBackendRouteError;
};

function resolveDependencies(dependencies: PostRemixesRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    enforceBackendRateLimit: dependencies?.enforceBackendRateLimit ?? enforceBackendRateLimit,
    getFeedNetworkKeyHash: dependencies?.getFeedNetworkKeyHash ?? getFeedNetworkKeyHash,
    listPostRemixes: dependencies?.listPostRemixes ?? listPostRemixes,
    logError: dependencies?.logError ?? logBackendRouteError,
  };
}

async function handlePostRemixesGET(
  request: Request,
  context: PostRemixesRouteContext,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  try {
    const { postId } = await context.params;
    const hasAuthorizationHeader = Boolean(request.headers.get('Authorization'));
    let viewerUserId: string | null = null;
    if (hasAuthorizationHeader) {
      const { data: { user } } = await getVerifiedAuthUserResult(dependencies.createUserClient(request));
      viewerUserId = user?.id ?? null;
    }

    const adminSupabase = dependencies.createServiceClient();
    try {
      await dependencies.enforceBackendRateLimit(adminSupabase, {
        ...SHOWCASE_POST_REMIXES_READ_RATE_LIMIT,
        key: viewerUserId ?? dependencies.getFeedNetworkKeyHash(request),
      });
    } catch (error) {
      if (error instanceof BackendRateLimitError) {
        return createBackendRateLimitResponse(error);
      }
      throw error;
    }

    const searchParams = new URL(request.url).searchParams;
    const result = await dependencies.listPostRemixes({
      adminSupabase,
      postId,
      viewerUserId,
      countryCode: request.headers.get('x-vercel-ip-country'),
      limit: normalizePostRemixesLimit(searchParams.get('limit')),
      offset: normalizePostRemixesOffset(searchParams.get('offset')),
    });
    if (!result.ok) {
      return NextResponse.json(result.body, { status: result.status });
    }

    return NextResponse.json(result.body, {
      headers: createApiResponseHeaders(request, getViewerAwareApiCacheControl(hasAuthorizationHeader), {
        vary: ['Authorization', 'x-vercel-ip-country'],
      }),
    });
  } catch (error) {
    dependencies.logError('Post remixes error:', error);
    return NextResponse.json({ error: 'Failed to load remixes.' }, { status: 500 });
  }
}

export async function getPostRemixesRouteResponse({
  context,
  dependencies,
  request,
}: {
  context: PostRemixesRouteContext;
  dependencies?: PostRemixesRouteDependencies;
  request: Request;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);
  return withProviderFetchRequestId(getApiRequestId(request), async () => (
    handlePostRemixesGET(request, context, resolvedDependencies)
  ));
}
