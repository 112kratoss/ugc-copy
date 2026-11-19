import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { isGuestUser } from '@/lib/account-identity';
import 'server-only';

import { after, NextResponse } from 'next/server';

import {
  API_CACHE_CONTROL,
  applyApiResponseHeaders,
  applyPrivateNoStoreApiResponseHeaders,
} from '@/lib/api-cache';
import {
  BackendRateLimitError,
  POST_COMMENTS_READ_RATE_LIMIT,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import type { RunAfterResponse } from '@/lib/deferrable-notification';
import { POST_COMMENTS_PUBLIC_SCOPE, POST_COMMENTS_SCOPE_PARAM } from '@/lib/post-comments-client';
import { getFeedNetworkKeyHash } from '@/lib/showcase-feed-identity';
import {
  createPostCommentForRoute,
  listPostCommentsForRoute,
  normalizePostCommentLimit,
  normalizePostCommentOffset,
  normalizePostCommentSort,
  removePostCommentForRoute,
  updatePostCommentForRoute,
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
  updatePostCommentForRoute?: typeof updatePostCommentForRoute;
  runAfterResponse?: RunAfterResponse;
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
    updatePostCommentForRoute: dependencies?.updatePostCommentForRoute ?? updatePostCommentForRoute,
    runAfterResponse: dependencies?.runAfterResponse ?? ((task) => after(task)),
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

/**
 * A Supabase session cookie of any project, whole or in chunks (`sb-<ref>-auth-token`,
 * `sb-<ref>-auth-token.0`, …), or the sign-in verifier beside it. Matched without the configured
 * project (which `hasSupabaseAuthCookie` reads), so the check fails closed: any such cookie keeps an
 * answer out of shared caches.
 */
function carriesSupabaseAuthCookie(request: Request) {
  return (request.headers.get('cookie') ?? '').split(';').some((part) => {
    const name = part.trim().split('=', 1)[0] ?? '';
    return name.startsWith('sb-') && name.includes('-auth-token');
  });
}

/**
 * The signed-out read the edge may keep: a request that asks for the public scope
 * (`POST_COMMENTS_PUBLIC_SCOPE`, what the web asks for a reader with no session) and carries no
 * session at all, neither an Authorization header (an empty one included) nor a Supabase session
 * cookie. Its answer is read for no viewer, so it holds nothing of a reader's own (no reaction of
 * theirs, no blocks applied) and is the same for every visitor: Vercel's CDN may keep it for a
 * minute and serve it a minute stale while it refreshes, so a new comment, or a removal by its
 * author, the post's creator or moderation, reaches a signed-out reader within about two minutes
 * (the accepted trade-off), and so does the thread of a post that goes private, is archived,
 * deleted or hidden by review, or whose creator is deleted. A request with any session that asks
 * for it gets today's per-viewer read, private, no-store, so a reader's own answer never enters a
 * shared cache. The app never sends `scope`, so it never asks for this answer (it reads with a
 * guest's token, or with none when its guest session could not start).
 */
function isSharedPublicRead(request: Request) {
  return new URL(request.url).searchParams.get(POST_COMMENTS_SCOPE_PARAM) === POST_COMMENTS_PUBLIC_SCOPE
    && !request.headers.has('authorization')
    && !carriesSupabaseAuthCookie(request);
}

async function handlePostCommentsGET(
  request: Request,
  context: PostCommentsRouteContext,
  dependencies: ReturnType<typeof resolveDependencies>,
  sharedPublicRead: boolean,
) {
  const { postId } = await context.params;
  // The shared read never resolves anyone: what it answers is every visitor's.
  const viewerUserId = sharedPublicRead ? null : await getViewerUserId(request, dependencies);
  const searchParams = new URL(request.url).searchParams;

  // Comment writes were limited while the read beside them was open, even
  // though listing is the more expensive half: it range-reads in a loop until
  // enough visible rows accumulate, issuing two user_blocks queries per pass.
  // Keyed on the viewer when signed in, otherwise on a salted network hash.
  // The shared read is counted too: its answer is served from the edge, so
  // only a miss or a refresh reaches here, and a refusal is never kept there.
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
      // The body may carry `deliveryId`, the feed delivery the comment was
      // written from; the service reads it with the comment itself.
      readBody: () => request.json(),
      createAdminSupabase: () => dependencies.createServiceClient(),
      // The comment's feed event is written behind the answer.
      runAfterResponse: dependencies.runAfterResponse,
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

async function handlePostCommentPATCH(
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
    await dependencies.updatePostCommentForRoute({
      postId,
      commentId,
      actorUserId,
      // One change: the comment's words, the reader's reaction, the heart or the pin.
      readBody: () => request.json(),
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
  const sharedPublicRead = isSharedPublicRead(request);
  const response = await handlePostCommentsGET(
    request,
    context,
    resolveDependencies(dependencies),
    sharedPublicRead,
  );
  // Only the thread itself is shared: a refusal (a missing post, one network's rate limit) is
  // answered to its own request alone. `Vary` names Authorization alone: Vercel's CDN keeps no
  // answer whose `Vary` names Cookie, and a cookie changes nothing in this read, which resolves a
  // reader only from a token.
  return sharedPublicRead && response.status === 200
    ? applyApiResponseHeaders(response, request, API_CACHE_CONTROL.publicMinuteEdge, { vary: ['Authorization'] })
    : applyPrivateNoStoreApiResponseHeaders(response, request, { vary: ['Authorization'] });
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

export async function updatePostCommentRouteResponse({
  context,
  dependencies,
  request,
}: {
  context: PostCommentRouteContext;
  dependencies?: PostCommentsRouteDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handlePostCommentPATCH(request, context, resolveDependencies(dependencies)),
    request,
  );
}
