import 'server-only';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { createBackendRateLimitResponse } from '@/lib/backend-rate-limit';
import { createOwnerPostForRoute } from '@/lib/post-create-route-service';
import { listOwnerPostsForRoute } from '@/lib/owner-post-list-route-service';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type PostsRouteDependencies = {
  createOwnerPostForRoute?: typeof createOwnerPostForRoute;
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  listOwnerPostsForRoute?: typeof listOwnerPostsForRoute;
  logError?: typeof console.error;
};

function resolveDependencies(dependencies: PostsRouteDependencies | undefined) {
  return {
    createOwnerPostForRoute: dependencies?.createOwnerPostForRoute ?? createOwnerPostForRoute,
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    listOwnerPostsForRoute: dependencies?.listOwnerPostsForRoute ?? listOwnerPostsForRoute,
    logError: dependencies?.logError ?? console.error,
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

    const result = await dependencies.createOwnerPostForRoute({
      adminSupabase: dependencies.createServiceClient(),
      ownerUserId,
      readFormData: () => request.formData(),
    });

    if (!result.ok) {
      if ('rateLimitError' in result && result.rateLimitError) {
        return createBackendRateLimitResponse(result.rateLimitError);
      }

      return NextResponse.json(result.body, { status: result.status });
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
