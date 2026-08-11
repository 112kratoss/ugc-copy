import { isGuestUser } from '@/lib/account-identity';
import 'server-only';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { createBackendRateLimitResponse } from '@/lib/backend-rate-limit';
import {
  cleanupProfileMedia,
  type ProfileMediaCleanupResult,
} from '@/lib/profile-media-cleanup-service';
import {
  createProfileMediaUploadIntent,
  type ProfileMediaUploadIntentResult,
} from '@/lib/profile-media-upload-sign';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type ProfileMediaRouteResult = ProfileMediaUploadIntentResult | ProfileMediaCleanupResult;

type ProfileMediaRouteDependencies = {
  cleanupProfileMedia?: typeof cleanupProfileMedia;
  createProfileMediaUploadIntent?: typeof createProfileMediaUploadIntent;
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
};

function resolveDependencies(dependencies: ProfileMediaRouteDependencies | undefined) {
  return {
    cleanupProfileMedia: dependencies?.cleanupProfileMedia ?? cleanupProfileMedia,
    createProfileMediaUploadIntent:
      dependencies?.createProfileMediaUploadIntent ?? createProfileMediaUploadIntent,
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
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

  // Guests hold a valid JWT but are not registered. Before anonymous
  // sessions existed these two were the same thing, so this check read
  // `!user` alone; it now has to say which it means. Registered-only per
  // route-identity-policy.ts.
  return error || !user || isGuestUser(user) ? null : user.id;
}

function toJsonResponse(result: ProfileMediaRouteResult) {
  if (!result.ok && result.rateLimitError) {
    return createBackendRateLimitResponse(result.rateLimitError);
  }

  if (!result.ok) {
    return NextResponse.json(result.body, { status: result.status });
  }

  return NextResponse.json(result.body);
}

async function readJsonBody(request: Request, invalidMessage: string) {
  try {
    return {
      ok: true as const,
      body: await request.json(),
    };
  } catch {
    return {
      ok: false as const,
      response: NextResponse.json({ error: invalidMessage }, { status: 400 }),
    };
  }
}

async function handleProfileMediaSignPOST(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const userId = await getAuthenticatedUserId(request, dependencies);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const parsedBody = await readJsonBody(request, 'Invalid profile media metadata.');
  if (!parsedBody.ok) return parsedBody.response;

  return toJsonResponse(await dependencies.createProfileMediaUploadIntent({
    body: parsedBody.body,
    userId,
    client: dependencies.createServiceClient,
  }));
}

async function handleProfileMediaCleanupPOST(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const userId = await getAuthenticatedUserId(request, dependencies);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const parsedBody = await readJsonBody(request, 'Invalid profile media cleanup request.');
  if (!parsedBody.ok) return parsedBody.response;

  return toJsonResponse(await dependencies.cleanupProfileMedia({
    body: parsedBody.body,
    userId,
    client: dependencies.createServiceClient,
  }));
}

export async function postProfileMediaSignRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: ProfileMediaRouteDependencies;
  request: Request;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);
  return applyPrivateNoStoreApiResponseHeaders(
    await handleProfileMediaSignPOST(request, resolvedDependencies),
    request,
  );
}

export async function postProfileMediaCleanupRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: ProfileMediaRouteDependencies;
  request: Request;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);
  return applyPrivateNoStoreApiResponseHeaders(
    await handleProfileMediaCleanupPOST(request, resolvedDependencies),
    request,
  );
}
