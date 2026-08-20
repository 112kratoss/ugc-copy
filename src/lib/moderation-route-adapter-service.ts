import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { isGuestUser } from '@/lib/account-identity';
import 'server-only';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { createBackendRateLimitResponse } from '@/lib/backend-rate-limit';
import {
  setUserBlockForRoute,
  submitModerationReportForRoute,
  type ModerationRouteResult,
} from '@/lib/moderation-service';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type ModerationRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  setUserBlockForRoute?: typeof setUserBlockForRoute;
  submitModerationReportForRoute?: typeof submitModerationReportForRoute;
};

function resolveDependencies(dependencies: ModerationRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    setUserBlockForRoute: dependencies?.setUserBlockForRoute ?? setUserBlockForRoute,
    submitModerationReportForRoute: dependencies?.submitModerationReportForRoute ?? submitModerationReportForRoute,
  };
}

async function getAuthenticatedUserId(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const supabase = dependencies.createUserClient(request);
  const { data: { user }, error } = await getVerifiedAuthUserResult(supabase);
  // Guests hold a valid JWT but are not registered. Before anonymous
  // sessions existed these two were the same thing, so this check read
  // `!user` alone; it now has to say which it means. Registered-only per
  // route-identity-policy.ts.
  return error || !user || isGuestUser(user) ? null : user.id;
}

function createModerationResponse(result: ModerationRouteResult) {
  if (!result.ok && result.rateLimitError) {
    return createBackendRateLimitResponse(result.rateLimitError);
  }
  return NextResponse.json(result.body, { status: result.ok ? 200 : result.status });
}

export async function postModerationReportRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: ModerationRouteDependencies;
  request: Request;
}) {
  const resolved = resolveDependencies(dependencies);
  const reporterUserId = await getAuthenticatedUserId(request, resolved);
  if (!reporterUserId) {
    return applyPrivateNoStoreApiResponseHeaders(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
      request,
    );
  }

  const body = await request.json().catch(() => null);
  const response = createModerationResponse(await resolved.submitModerationReportForRoute({
    adminSupabase: resolved.createServiceClient(),
    body,
    reporterUserId,
  }));
  return applyPrivateNoStoreApiResponseHeaders(response, request);
}

export async function userBlockRouteResponse({
  blockedUserId,
  dependencies,
  request,
  shouldBlock,
}: {
  blockedUserId: string;
  dependencies?: ModerationRouteDependencies;
  request: Request;
  shouldBlock: boolean;
}) {
  const resolved = resolveDependencies(dependencies);
  const actorUserId = await getAuthenticatedUserId(request, resolved);
  if (!actorUserId) {
    return applyPrivateNoStoreApiResponseHeaders(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
      request,
    );
  }

  const response = createModerationResponse(await resolved.setUserBlockForRoute({
    actorUserId,
    adminSupabase: resolved.createServiceClient(),
    blockedUserId,
    shouldBlock,
  }));
  return applyPrivateNoStoreApiResponseHeaders(response, request);
}

export function createUserBlockRouteHandlers({
  dependencies,
}: {
  dependencies?: ModerationRouteDependencies;
} = {}) {
  const handle = async (request: Request, context: { params: Promise<{ userId: string }> }, shouldBlock: boolean) => {
    const { userId } = await context.params;
    return userBlockRouteResponse({ blockedUserId: userId, dependencies, request, shouldBlock });
  };

  return {
    DELETE: (request: Request, context: { params: Promise<{ userId: string }> }) => handle(request, context, false),
    POST: (request: Request, context: { params: Promise<{ userId: string }> }) => handle(request, context, true),
  };
}
