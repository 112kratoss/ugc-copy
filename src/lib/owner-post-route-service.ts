import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  getOwnerPostDetail,
  type OwnerPostDetail,
} from '@/lib/owner-posts';
import {
  deleteOwnerPostForRoute,
  type PostDeleteRouteResult,
} from '@/lib/post-delete-service';
import {
  updateOwnerPostForRoute,
  type PostUpdateRequestBody,
  type PostUpdateRouteResult,
} from '@/lib/post-update-service';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type OwnerPostRouteDependencies = {
  createUserClient?: typeof createUserClient;
  createServiceClient?: () => SupabaseClient;
  getOwnerPostDetail?: typeof getOwnerPostDetail;
  updateOwnerPostForRoute?: typeof updateOwnerPostForRoute;
  deleteOwnerPostForRoute?: typeof deleteOwnerPostForRoute;
};

type OwnerPostUnauthorizedResult = {
  ok: false;
  status: 401;
  body: { error: 'Unauthorized' };
};

export type OwnerPostDetailRouteResult =
  | {
      ok: true;
      body: {
        success: true;
        post: OwnerPostDetail;
      };
    }
  | OwnerPostUnauthorizedResult
  | {
      ok: false;
      status: 404 | 500;
      body: { error: string };
    };

export type OwnerPostMutationRouteResult =
  | PostUpdateRouteResult
  | PostDeleteRouteResult
  | OwnerPostUnauthorizedResult
  | {
      ok: false;
      status: 500;
      body: { error: string };
    };

function resolveDependencies(dependencies: OwnerPostRouteDependencies | undefined) {
  return {
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    getOwnerPostDetail: dependencies?.getOwnerPostDetail ?? getOwnerPostDetail,
    updateOwnerPostForRoute: dependencies?.updateOwnerPostForRoute ?? updateOwnerPostForRoute,
    deleteOwnerPostForRoute: dependencies?.deleteOwnerPostForRoute ?? deleteOwnerPostForRoute,
  };
}

async function authenticateOwnerPostRequest(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
): Promise<{ ok: true; userId: string } | OwnerPostUnauthorizedResult> {
  const supabase = dependencies.createUserClient(request);
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return {
      ok: false,
      status: 401,
      body: { error: 'Unauthorized' },
    };
  }

  return { ok: true, userId: user.id };
}

export async function getOwnerPostDetailForRoute({
  request,
  postId,
  dependencies,
}: {
  request: Request;
  postId: string;
  dependencies?: OwnerPostRouteDependencies;
}): Promise<OwnerPostDetailRouteResult> {
  const resolvedDependencies = resolveDependencies(dependencies);
  const auth = await authenticateOwnerPostRequest(request, resolvedDependencies);
  if (!auth.ok) return auth;

  try {
    const detail = await resolvedDependencies.getOwnerPostDetail(postId, auth.userId, {
      countryCode: request.headers.get('x-vercel-ip-country'),
    });

    if (!detail) {
      return { ok: false, status: 404, body: { error: 'Post not found.' } };
    }

    return {
      ok: true,
      body: {
        success: true,
        post: detail,
      },
    };
  } catch (error) {
    console.error('Failed to fetch owner post detail:', error);
    return { ok: false, status: 500, body: { error: 'Failed to fetch post.' } };
  }
}

export async function updateOwnerPostRoute({
  request,
  postId,
  dependencies,
}: {
  request: Request;
  postId: string;
  dependencies?: OwnerPostRouteDependencies;
}): Promise<OwnerPostMutationRouteResult> {
  const resolvedDependencies = resolveDependencies(dependencies);
  const auth = await authenticateOwnerPostRequest(request, resolvedDependencies);
  if (!auth.ok) return auth;

  try {
    const adminSupabase = resolvedDependencies.createServiceClient();
    const body = (await request.json()) as PostUpdateRequestBody;
    return resolvedDependencies.updateOwnerPostForRoute({
      adminSupabase,
      ownerUserId: auth.userId,
      postId,
      body,
    });
  } catch (error) {
    console.error('Failed to update owner post:', error);
    return { ok: false, status: 500, body: { error: 'Failed to update post.' } };
  }
}

export async function deleteOwnerPostRoute({
  request,
  postId,
  dependencies,
}: {
  request: Request;
  postId: string;
  dependencies?: OwnerPostRouteDependencies;
}): Promise<OwnerPostMutationRouteResult> {
  const resolvedDependencies = resolveDependencies(dependencies);
  const auth = await authenticateOwnerPostRequest(request, resolvedDependencies);
  if (!auth.ok) return auth;

  try {
    const adminSupabase = resolvedDependencies.createServiceClient();
    const body = request.headers.get('content-length') && request.headers.get('content-length') !== '0'
      ? ((await request.json()) as { force?: boolean })
      : { force: false };

    return resolvedDependencies.deleteOwnerPostForRoute({
      adminSupabase,
      ownerUserId: auth.userId,
      postId,
      forceDelete: Boolean(body.force),
    });
  } catch (error) {
    console.error('Failed to delete owner post:', error);
    return { ok: false, status: 500, body: { error: 'Failed to delete post.' } };
  }
}
