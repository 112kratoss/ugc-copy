import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { isGuestUser } from '@/lib/account-identity';
import 'server-only';
import { logBackendRouteError } from '@/lib/backend-logger';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { createBackendRateLimitResponse } from '@/lib/backend-rate-limit';
import {
  archiveOwnerPostForRoute,
  restoreOwnerPostForRoute,
  type PostLifecycleResult,
} from '@/lib/post-lifecycle-service';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type PostLifecycleAction = 'archive' | 'restore';

type PostLifecycleRouteDependencies = {
  archiveOwnerPostForRoute?: typeof archiveOwnerPostForRoute;
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  logError?: typeof logBackendRouteError;
  restoreOwnerPostForRoute?: typeof restoreOwnerPostForRoute;
};

function resolveDependencies(dependencies: PostLifecycleRouteDependencies | undefined) {
  return {
    archiveOwnerPostForRoute: dependencies?.archiveOwnerPostForRoute ?? archiveOwnerPostForRoute,
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    logError: dependencies?.logError ?? logBackendRouteError,
    restoreOwnerPostForRoute: dependencies?.restoreOwnerPostForRoute ?? restoreOwnerPostForRoute,
  };
}

function toJsonResponse(result: PostLifecycleResult) {
  if (!result.ok) {
    if ('rateLimitError' in result) {
      return createBackendRateLimitResponse(result.rateLimitError);
    }

    return NextResponse.json(result.body, { status: result.status });
  }

  return NextResponse.json(result.body);
}

function getFailureMessage(action: PostLifecycleAction) {
  return action === 'archive' ? 'Failed to archive post.' : 'Failed to restore post.';
}

function getLogMessage(action: PostLifecycleAction) {
  return action === 'archive' ? 'Failed to archive owner post:' : 'Failed to restore owner post:';
}

async function handlePostLifecyclePOST({
  action,
  dependencies,
  postId,
  request,
}: {
  action: PostLifecycleAction;
  dependencies: ReturnType<typeof resolveDependencies>;
  postId: string;
  request: Request;
}) {
  const supabase = dependencies.createUserClient(request);
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

  try {
    const serviceInput = {
      adminSupabase: dependencies.createServiceClient(),
      ownerUserId: user.id,
      postId,
    };
    const result = action === 'archive'
      ? await dependencies.archiveOwnerPostForRoute(serviceInput)
      : await dependencies.restoreOwnerPostForRoute(serviceInput);

    return toJsonResponse(result);
  } catch (error) {
    dependencies.logError(getLogMessage(action), error);
    return NextResponse.json({ error: getFailureMessage(action) }, { status: 500 });
  }
}

async function postOwnerPostLifecycleRouteResponse({
  action,
  dependencies,
  postId,
  request,
}: {
  action: PostLifecycleAction;
  dependencies?: PostLifecycleRouteDependencies;
  postId: string;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handlePostLifecyclePOST({
      action,
      dependencies: resolveDependencies(dependencies),
      postId,
      request,
    }),
    request,
  );
}

export function postOwnerPostArchiveRouteResponse({
  dependencies,
  postId,
  request,
}: {
  dependencies?: PostLifecycleRouteDependencies;
  postId: string;
  request: Request;
}) {
  return postOwnerPostLifecycleRouteResponse({
    action: 'archive',
    dependencies,
    postId,
    request,
  });
}

export function postOwnerPostRestoreRouteResponse({
  dependencies,
  postId,
  request,
}: {
  dependencies?: PostLifecycleRouteDependencies;
  postId: string;
  request: Request;
}) {
  return postOwnerPostLifecycleRouteResponse({
    action: 'restore',
    dependencies,
    postId,
    request,
  });
}
