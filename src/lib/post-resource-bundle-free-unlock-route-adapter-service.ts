import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { isGuestUser } from '@/lib/account-identity';
import 'server-only';

import { after, NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { createBackendRateLimitResponse } from '@/lib/backend-rate-limit';
import {
  unlockFreePostResourceBundleForRoute,
  type PostResourceBundleFreeUnlockRouteResult,
} from '@/lib/post-resource-bundle-free-unlock-service';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type RunAfterResponse = (task: () => Promise<unknown>) => void;

type PostResourceBundleFreeUnlockRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  runAfterResponse?: RunAfterResponse;
  unlockFreePostResourceBundleForRoute?: typeof unlockFreePostResourceBundleForRoute;
};

function resolveDependencies(
  dependencies: PostResourceBundleFreeUnlockRouteDependencies | undefined,
) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    runAfterResponse: dependencies?.runAfterResponse ?? ((task) => after(task)),
    unlockFreePostResourceBundleForRoute:
      dependencies?.unlockFreePostResourceBundleForRoute ?? unlockFreePostResourceBundleForRoute,
  };
}

function toJsonResponse(result: PostResourceBundleFreeUnlockRouteResult) {
  if (!result.ok && result.rateLimitError) {
    return createBackendRateLimitResponse(result.rateLimitError);
  }

  return NextResponse.json(result.body, { status: result.ok ? 200 : result.status });
}

async function handlePostResourceBundleFreeUnlockPOST({
  dependencies,
  postId,
  request,
}: {
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

  return toJsonResponse(await dependencies.unlockFreePostResourceBundleForRoute({
    adminSupabase: dependencies.createServiceClient(),
    postId,
    buyerUserId: user.id,
    // The buyer's next request waits on this answer, so the pushes go out
    // behind it rather than in front.
    runAfterResponse: dependencies.runAfterResponse,
  }));
}

export async function postResourceBundleFreeUnlockRouteResponse({
  dependencies,
  postId,
  request,
}: {
  dependencies?: PostResourceBundleFreeUnlockRouteDependencies;
  postId: string;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handlePostResourceBundleFreeUnlockPOST({
      dependencies: resolveDependencies(dependencies),
      postId,
      request,
    }),
    request,
  );
}
