import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { isGuestUser } from '@/lib/account-identity';
import 'server-only';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { createBackendRateLimitResponse } from '@/lib/backend-rate-limit';
import {
  createPostResourceFileUploadIntent,
  finalizePostResourceFileUpload,
  type PostResourceFileDirectUploadClient,
  type PostResourceFileDirectUploadResult,
} from '@/lib/post-resource-file-direct-upload-service';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type DirectUploadAction = 'finalize' | 'sign';
const defaultCreateServiceClient = createServiceClient as unknown as () => PostResourceFileDirectUploadClient;

type PostResourceFileDirectUploadRouteDependencies = {
  createServiceClient?: () => PostResourceFileDirectUploadClient;
  createUserClient?: typeof createUserClient;
  createPostResourceFileUploadIntent?: typeof createPostResourceFileUploadIntent;
  finalizePostResourceFileUpload?: typeof finalizePostResourceFileUpload;
};

function resolveDependencies(dependencies: PostResourceFileDirectUploadRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient
      ?? defaultCreateServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    createPostResourceFileUploadIntent:
      dependencies?.createPostResourceFileUploadIntent ?? createPostResourceFileUploadIntent,
    finalizePostResourceFileUpload:
      dependencies?.finalizePostResourceFileUpload ?? finalizePostResourceFileUpload,
  };
}

function toJsonResponse(result: PostResourceFileDirectUploadResult) {
  if (!result.ok && result.rateLimitError) {
    return createBackendRateLimitResponse(result.rateLimitError);
  }
  return NextResponse.json(result.body, { status: result.ok ? 200 : result.status });
}

async function handlePostResourceFileDirectUpload(
  action: DirectUploadAction,
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid resource upload metadata.' }, { status: 400 });
  }

  const client = dependencies.createServiceClient();
  const result = action === 'sign'
    ? await dependencies.createPostResourceFileUploadIntent({ body, client, userId: user.id })
    : await dependencies.finalizePostResourceFileUpload({ body, client, userId: user.id });
  return toJsonResponse(result);
}

export async function postPostResourceFileDirectUploadRouteResponse({
  action,
  dependencies,
  request,
}: {
  action: DirectUploadAction;
  dependencies?: PostResourceFileDirectUploadRouteDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handlePostResourceFileDirectUpload(action, request, resolveDependencies(dependencies)),
    request,
  );
}
