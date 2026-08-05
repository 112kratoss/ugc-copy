import 'server-only';
import { logBackendRouteError, logBackendWarning } from '@/lib/backend-logger';

import { NextResponse, after } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { createBackendRateLimitResponse } from '@/lib/backend-rate-limit';
import { createOwnerPostForRoute } from '@/lib/post-create-route-service';
import { listOwnerPostsForRoute } from '@/lib/owner-post-list-route-service';
import { repairMediaForPost } from '@/lib/media-preview-repair';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type PostsRouteDependencies = {
  createOwnerPostForRoute?: typeof createOwnerPostForRoute;
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  listOwnerPostsForRoute?: typeof listOwnerPostsForRoute;
  logError?: typeof logBackendRouteError;
  repairMediaForPost?: typeof repairMediaForPost;
  /** Seam over `after` so tests can drive the post-response work directly. */
  schedulePostMediaRepair?: (callback: () => Promise<void>) => void;
};

function resolveDependencies(dependencies: PostsRouteDependencies | undefined) {
  return {
    createOwnerPostForRoute: dependencies?.createOwnerPostForRoute ?? createOwnerPostForRoute,
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    listOwnerPostsForRoute: dependencies?.listOwnerPostsForRoute ?? listOwnerPostsForRoute,
    logError: dependencies?.logError ?? logBackendRouteError,
    repairMediaForPost: dependencies?.repairMediaForPost ?? repairMediaForPost,
    schedulePostMediaRepair: dependencies?.schedulePostMediaRepair
      ?? ((callback: () => Promise<void>) => after(callback)),
  };
}

async function getAuthenticatedUserId(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const supabase = dependencies.createUserClient(request);
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  return authError || !user ? null : user.id;
}

async function handlePostsPOST(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  try {
    const ownerUserId = await getAuthenticatedUserId(request, dependencies);
    if (!ownerUserId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const adminSupabase = dependencies.createServiceClient();
    const result = await dependencies.createOwnerPostForRoute({
      adminSupabase,
      ownerUserId,
      readFormData: () => request.formData(),
    });

    if (!result.ok) {
      if ('rateLimitError' in result && result.rateLimitError) {
        return createBackendRateLimitResponse(result.rateLimitError);
      }

      return NextResponse.json(result.body, { status: result.status });
    }

    // Publishing defers preview and rendition work so the response does not
    // wait on a transcode. Without this kick a new post would carry a
    // placeholder until the hourly sweep reached it. Scheduled unconditionally:
    // a text post costs two indexed reads that match nothing.
    //
    // Both layers swallow deliberately. The post is already published, and the
    // hourly sweep repairs exactly this work, so neither a scheduling failure
    // nor a repair failure may turn a successful publish into an error.
    const { postId } = result.body;
    try {
      dependencies.schedulePostMediaRepair(async () => {
        try {
          await dependencies.repairMediaForPost(adminSupabase, postId);
        } catch (error) {
          logBackendWarning('post_media_async_repair_failed', { error, postId });
        }
      });
    } catch (error) {
      logBackendWarning('post_media_async_repair_not_scheduled', { error, postId });
    }

    return NextResponse.json(result.body);
  } catch (error) {
    dependencies.logError('External post creation failed:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function handlePostsGET(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  try {
    const userId = await getAuthenticatedUserId(request, dependencies);
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const result = await dependencies.listOwnerPostsForRoute({
      userId,
      searchParams: new URL(request.url).searchParams,
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    return NextResponse.json({
      success: true,
      posts: result.posts,
      pageInfo: result.pageInfo,
      ...(result.summary ? { summary: result.summary } : {}),
    });
  } catch (error) {
    dependencies.logError('Failed to fetch owner posts:', error);
    return NextResponse.json({ error: 'Failed to fetch posts.' }, { status: 500 });
  }
}

export async function postPostsRouteResponse({
  request,
  dependencies,
}: {
  request: Request;
  dependencies?: PostsRouteDependencies;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);
  return applyPrivateNoStoreApiResponseHeaders(
    await handlePostsPOST(request, resolvedDependencies),
    request,
  );
}

export async function getPostsRouteResponse({
  request,
  dependencies,
}: {
  request: Request;
  dependencies?: PostsRouteDependencies;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);
  return applyPrivateNoStoreApiResponseHeaders(
    await handlePostsGET(request, resolvedDependencies),
    request,
  );
}

export function createPostsRouteHandlers({
  dependencies,
}: {
  dependencies?: PostsRouteDependencies;
} = {}) {
  return {
    GET(request: Request) {
      return getPostsRouteResponse({ dependencies, request });
    },
    POST(request: Request) {
      return postPostsRouteResponse({ dependencies, request });
    },
  };
}
