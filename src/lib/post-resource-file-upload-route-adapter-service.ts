import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { isGuestUser } from '@/lib/account-identity';
import 'server-only';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { createBackendRateLimitResponse } from '@/lib/backend-rate-limit';
import {
  uploadPostResourceFileForRoute,
  type PostResourceFileUploadClient,
  type PostResourceFileUploadResult,
} from '@/lib/post-resource-file-upload-service';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type PostResourceFileUploadRouteDependencies = {
  createServiceClient?: () => PostResourceFileUploadClient;
  createUserClient?: typeof createUserClient;
  uploadPostResourceFileForRoute?: typeof uploadPostResourceFileForRoute;
};

function resolveDependencies(dependencies: PostResourceFileUploadRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? (createServiceClient as () => PostResourceFileUploadClient),
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    uploadPostResourceFileForRoute:
      dependencies?.uploadPostResourceFileForRoute ?? uploadPostResourceFileForRoute,
  };
}

function toJsonResponse(result: PostResourceFileUploadResult) {
  if (!result.ok && result.rateLimitError) {
    return createBackendRateLimitResponse(result.rateLimitError);
  }

  if (!result.ok) {
    return NextResponse.json(result.body, { status: result.status });
  }

  return NextResponse.json(result.body);
}

async function handlePostResourceFileUploadPOST(
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

  return toJsonResponse(await dependencies.uploadPostResourceFileForRoute({
    client: dependencies.createServiceClient(),
    userId: user.id,
    readFormData: () => request.formData(),
  }));
}

export async function postPostResourceFileUploadRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: PostResourceFileUploadRouteDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handlePostResourceFileUploadPOST(request, resolveDependencies(dependencies)),
    request,
  );
}

export function postRetiredPostResourceFileUploadRouteResponse(request: Request) {
  return applyPrivateNoStoreApiResponseHeaders(
    NextResponse.json(
      {
        error: 'Multipart resource uploads have been retired. Use the signed direct-upload flow.',
        code: 'DIRECT_UPLOAD_REQUIRED',
        signPath: '/api/posts/resource-files/sign',
        finalizePath: '/api/posts/resource-files/finalize',
      },
      { status: 410 },
    ),
    request,
  );
}
