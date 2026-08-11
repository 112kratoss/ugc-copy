import { isGuestUser } from '@/lib/account-identity';
import 'server-only';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { createBackendRateLimitResponse } from '@/lib/backend-rate-limit';
import {
  submitPostReportForRoute,
  type PostReportRouteResult,
} from '@/lib/post-report-service';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type PostReportRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  submitPostReportForRoute?: typeof submitPostReportForRoute;
};

function resolveDependencies(dependencies: PostReportRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    submitPostReportForRoute: dependencies?.submitPostReportForRoute ?? submitPostReportForRoute,
  };
}

function toJsonResponse(result: PostReportRouteResult) {
  if (!result.ok && result.rateLimitError) {
    return createBackendRateLimitResponse(result.rateLimitError);
  }

  return NextResponse.json(result.body, { status: result.ok ? 200 : result.status });
}

async function handlePostReportPOST({
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
  } = await supabase.auth.getUser();

  // Registered-only per route-identity-policy.ts. A guest holds a valid
    // JWT, so `!user` alone stopped meaning "not registered" the moment
    // anonymous sessions existed.
    if (authError || !user || isGuestUser(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return toJsonResponse(await dependencies.submitPostReportForRoute({
    postId,
    reporterUserId: user.id,
    readBody: () => request.json(),
    createAdminSupabase: () => dependencies.createServiceClient(),
  }));
}

export async function postReportRouteResponse({
  dependencies,
  postId,
  request,
}: {
  dependencies?: PostReportRouteDependencies;
  postId: string;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handlePostReportPOST({
      dependencies: resolveDependencies(dependencies),
      postId,
      request,
    }),
    request,
  );
}
