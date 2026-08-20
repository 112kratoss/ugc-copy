import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { isGuestUser } from '@/lib/account-identity';
import 'server-only';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import {
  BackendRateLimitError,
  POST_COMMENTS_READ_RATE_LIMIT,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { getFeedNetworkKeyHash } from '@/lib/showcase-feed-identity';
import {
  createPostCommentForRoute,
  listPostCommentsForRoute,
  normalizePostCommentLimit,
  normalizePostCommentOffset,
  normalizePostCommentSort,
  removePostCommentForRoute,
  type PostCommentsRouteResult,
} from '@/lib/post-comments-service';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

export type PostCommentsRouteContext = {
  params: Promise<{ postId: string }>;
};

export type PostCommentRouteContext = {
  params: Promise<{ postId: string; commentId: string }>;
};

type PostCommentsRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  createPostCommentForRoute?: typeof createPostCommentForRoute;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  getFeedNetworkKeyHash?: typeof getFeedNetworkKeyHash;
  listPostCommentsForRoute?: typeof listPostCommentsForRoute;
  removePostCommentForRoute?: typeof removePostCommentForRoute;
};

function resolveDependencies(dependencies: PostCommentsRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    createPostCommentForRoute: dependencies?.createPostCommentForRoute ?? createPostCommentForRoute,
    enforceBackendRateLimit: dependencies?.enforceBackendRateLimit ?? enforceBackendRateLimit,
    getFeedNetworkKeyHash: dependencies?.getFeedNetworkKeyHash ?? getFeedNetworkKeyHash,
    listPostCommentsForRoute: dependencies?.listPostCommentsForRoute ?? listPostCommentsForRoute,
    removePostCommentForRoute: dependencies?.removePostCommentForRoute ?? removePostCommentForRoute,
  };
}

function toJsonResponse<TBody>(result: PostCommentsRouteResult<TBody>) {
  if (!result.ok && result.rateLimitError) {
    return createBackendRateLimitResponse(result.rateLimitError);
  }

  return NextResponse.json(result.body, { status: result.status });
}

async function getViewerUserId(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  if (!request.headers.get('Authorization')) return null;

  const supabase = dependencies.createUserClient(request);
  const {
    data: { user },
  } = await getVerifiedAuthUserResult(supabase);
  return user?.id ?? null;
}

async function requireViewerUserId(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const supabase = dependencies.createUserClient(request);
  const {
    data: { user },
    error,
  } = await getVerifiedAuthUserResult(supabase);

  // Guests hold a valid JWT but are not registered. Before anonymous
  // sessions existed these two were the same thing, so this check read
  // `!user` alone; it now has to say which it means. Registered-only per
  // route-identity-policy.ts.
  return error || !user || isGuestUser(user) ? null : user.id;
}

async function handlePostCommentsGET(
  request: Request,
  context: PostCommentsRouteContext,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const { postId } = await context.params;
  const viewerUserId = await getViewerUserId(request, dependencies);
  const searchParams = new URL(request.url).searchParams;

  // Comment writes were limited while the read beside them was open, even
  // though listing is the more expensive half: it range-reads in a loop until
  // enough visible rows accumulate, issuing two user_blocks queries per pass.
  // Keyed on the viewer when signed in, otherwise on a salted network hash.
  try {
    await dependencies.enforceBackendRateLimit(dependencies.createServiceClient(), {
      ...POST_COMMENTS_READ_RATE_LIMIT,
      key: viewerUserId ?? dependencies.getFeedNetworkKeyHash(request),
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return createBackendRateLimitResponse(error);
    }

    throw error;
  }

  const result = await dependencies.listPostCommentsForRoute({
    postId,
    viewerUserId,
    parentId: searchParams.get('parentId'),
    sort: normalizePostCommentSort(searchParams.get('sort')),
    limit: normalizePostCommentLimit(searchParams.get('limit')),
    offset: normalizePostCommentOffset(searchParams.get('offset')),
    createAdminSupabase: () => dependencies.createServiceClient(),
  });

  if (!result.ok) {
    return toJsonResponse(result);
  }

  return NextResponse.json(result.body);
}

async function handlePostCommentsPOST(
  request: Request,
  context: PostCommentsRouteContext,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const { postId } = await context.params;
  const authorUserId = await requireViewerUserId(request, dependencies);

  if (!authorUserId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return toJsonResponse(
    await dependencies.createPostCommentForRoute({
      postId,
      authorUserId,
      readBody: () => request.json(),
      createAdminSupabase: () => dependencies.createServiceClient(),
    }),
  );
}

async function handlePostCommentDELETE(
  request: Request,
  context: PostCommentRouteContext,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const { postId, commentId } = await context.params;
  const actorUserId = await requireViewerUserId(request, dependencies);

  if (!actorUserId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return toJsonResponse(
    await dependencies.removePostCommentForRoute({
      postId,
      commentId,
      actorUserId,
      createAdminSupabase: () => dependencies.createServiceClient(),
    }),
  );
}

export async function getPostCommentsRouteResponse({
  context,
  dependencies,
  request,
}: {
  context: PostCommentsRouteContext;
  dependencies?: PostCommentsRouteDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handlePostCommentsGET(request, context, resolveDependencies(dependencies)),
    request,
    { vary: ['Authorization'] },
  );
}

export async function createPostCommentRouteResponse({
  context,
  dependencies,
  request,
}: {
  context: PostCommentsRouteContext;
  dependencies?: PostCommentsRouteDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handlePostCommentsPOST(request, context, resolveDependencies(dependencies)),
    request,
  );
}

export async function deletePostCommentRouteResponse({
  context,
  dependencies,
  request,
}: {
  context: PostCommentRouteContext;
  dependencies?: PostCommentsRouteDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handlePostCommentDELETE(request, context, resolveDependencies(dependencies)),
    request,
  );
}
