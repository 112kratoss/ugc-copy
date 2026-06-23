import 'server-only';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { createBackendRateLimitResponse } from '@/lib/backend-rate-limit';
import {
  getCreatorFollowStateForRoute,
  notifyCreatorFollowForRoute,
  updateCreatorFollowForRoute,
  type ProfileFollowRouteResult,
} from '@/lib/profile-follow-service';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type ProfileFollowRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  getCreatorFollowStateForRoute?: typeof getCreatorFollowStateForRoute;
  notifyCreatorFollowForRoute?: typeof notifyCreatorFollowForRoute;
  updateCreatorFollowForRoute?: typeof updateCreatorFollowForRoute;
  logError?: typeof console.error;
};

function resolveDependencies(dependencies: ProfileFollowRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    getCreatorFollowStateForRoute: dependencies?.getCreatorFollowStateForRoute
      ?? getCreatorFollowStateForRoute,
    notifyCreatorFollowForRoute: dependencies?.notifyCreatorFollowForRoute
      ?? notifyCreatorFollowForRoute,
    updateCreatorFollowForRoute: dependencies?.updateCreatorFollowForRoute
      ?? updateCreatorFollowForRoute,
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
    error,
  } = await supabase.auth.getUser();

  return error || !user ? null : user.id;
}

function createProfileFollowResponse(result: ProfileFollowRouteResult) {
  if (result.ok) {
    return NextResponse.json(result.body);
  }

  if (result.rateLimitError) {
    return createBackendRateLimitResponse(result.rateLimitError);
  }

  return NextResponse.json(result.body, { status: result.status });
}

async function handleProfileFollowGET(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  try {
    const followerId = await getAuthenticatedUserId(request, dependencies);
    if (!followerId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const followingId = new URL(request.url).searchParams.get('followingId')?.trim() ?? '';
    return createProfileFollowResponse(await dependencies.getCreatorFollowStateForRoute({
      adminSupabase: dependencies.createServiceClient,
      followerId,
      followingId,
    }));
  } catch (error) {
    dependencies.logError('Creator follow state failed:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function handleProfileFollowPOST(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  try {
    const followerId = await getAuthenticatedUserId(request, dependencies);
    if (!followerId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json().catch(() => null);
    return createProfileFollowResponse(await dependencies.updateCreatorFollowForRoute({
      adminSupabase: dependencies.createServiceClient,
      followerId,
      body,
    }));
  } catch (error) {
    dependencies.logError('Creator follow mutation failed:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function handleProfileFollowNotifyPOST(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  try {
    const followerId = await getAuthenticatedUserId(request, dependencies);
    if (!followerId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json().catch(() => null);
    return createProfileFollowResponse(await dependencies.notifyCreatorFollowForRoute({
      adminSupabase: dependencies.createServiceClient,
      followerId,
      body,
    }));
  } catch (error) {
    dependencies.logError('Creator follow notification failed:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function getProfileFollowRouteResponse({
  request,
  dependencies,
}: {
  request: Request;
  dependencies?: ProfileFollowRouteDependencies;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);
  return applyPrivateNoStoreApiResponseHeaders(
    await handleProfileFollowGET(request, resolvedDependencies),
    request,
  );
}

export async function postProfileFollowNotifyRouteResponse({
  request,
  dependencies,
}: {
  request: Request;
  dependencies?: ProfileFollowRouteDependencies;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);
  return applyPrivateNoStoreApiResponseHeaders(
    await handleProfileFollowNotifyPOST(request, resolvedDependencies),
    request,
  );
}

export async function postProfileFollowRouteResponse({
  request,
  dependencies,
}: {
  request: Request;
  dependencies?: ProfileFollowRouteDependencies;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);
  return applyPrivateNoStoreApiResponseHeaders(
    await handleProfileFollowPOST(request, resolvedDependencies),
    request,
  );
}

export function createProfileFollowRouteHandlers({
  dependencies,
}: {
  dependencies?: ProfileFollowRouteDependencies;
} = {}) {
  return {
    GET(request: Request) {
      return getProfileFollowRouteResponse({ dependencies, request });
    },
    POST(request: Request) {
      return postProfileFollowRouteResponse({ dependencies, request });
    },
  };
}
