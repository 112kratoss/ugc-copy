import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { isGuestUser } from '@/lib/account-identity';
import 'server-only';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { createBackendRateLimitResponse } from '@/lib/backend-rate-limit';
import {
  GUEST_REPORT_REGISTRATION_REQUIRED,
  listUserBlocksForRoute,
  setUserBlockForRoute,
  submitModerationReportForRoute,
  type ModerationRouteResult,
} from '@/lib/moderation-service';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type ModerationRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  listUserBlocksForRoute?: typeof listUserBlocksForRoute;
  setUserBlockForRoute?: typeof setUserBlockForRoute;
  submitModerationReportForRoute?: typeof submitModerationReportForRoute;
};

function resolveDependencies(dependencies: ModerationRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    listUserBlocksForRoute: dependencies?.listUserBlocksForRoute ?? listUserBlocksForRoute,
    setUserBlockForRoute: dependencies?.setUserBlockForRoute ?? setUserBlockForRoute,
    submitModerationReportForRoute: dependencies?.submitModerationReportForRoute ?? submitModerationReportForRoute,
  };
}

async function getAuthenticatedUser(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const supabase = dependencies.createUserClient(request);
  const { data: { user }, error } = await getVerifiedAuthUserResult(supabase);
  return error || !user ? null : user;
}

async function getAuthenticatedUserId(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const user = await getAuthenticatedUser(request, dependencies);
  // Guests hold a valid JWT but are not registered. Before anonymous
  // sessions existed these two were the same thing, so this check read
  // `!user` alone; it now has to say which it means. Registered-only per
  // route-identity-policy.ts.
  return !user || isGuestUser(user) ? null : user.id;
}

function isGenerationReport(body: unknown) {
  return typeof body === 'object' && body !== null
    && (body as { targetType?: unknown }).targetType === 'generation';
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
  const reporter = await getAuthenticatedUser(request, resolved);
  if (!reporter) {
    return applyPrivateNoStoreApiResponseHeaders(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
      request,
    );
  }

  const body = await request.json().catch(() => null);
  const reporterIsGuest = isGuestUser(reporter);
  // The proxy lets a guest's report through (GUEST_WRITABLE_REGISTERED_ROUTES)
  // for one target: a generation its own credits made, which the service
  // checks. Posts, people, comments and templates still take an account, and a
  // guest is told so with the proxy's 403, never a 401 the app would read as a
  // session that has ended.
  if (reporterIsGuest && !isGenerationReport(body)) {
    return applyPrivateNoStoreApiResponseHeaders(
      createModerationResponse(GUEST_REPORT_REGISTRATION_REQUIRED),
      request,
    );
  }

  const response = createModerationResponse(await resolved.submitModerationReportForRoute({
    adminSupabase: resolved.createServiceClient(),
    body,
    reporterIsGuest,
    reporterUserId: reporter.id,
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

/** Whom the signed-in viewer has blocked: theirs alone, and kept out of every cache. */
export async function userBlockListRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: ModerationRouteDependencies;
  request: Request;
}) {
  const resolved = resolveDependencies(dependencies);
  const actorUserId = await getAuthenticatedUserId(request, resolved);
  if (!actorUserId) {
    return applyPrivateNoStoreApiResponseHeaders(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
      request,
    );
  }

  const result = await resolved.listUserBlocksForRoute({
    actorUserId,
    adminSupabase: resolved.createServiceClient(),
  });
  return applyPrivateNoStoreApiResponseHeaders(
    NextResponse.json(result.body, { status: result.ok ? 200 : result.status }),
    request,
  );
}

export function createUserBlockListRouteHandlers({
  dependencies,
}: {
  dependencies?: ModerationRouteDependencies;
} = {}) {
  return {
    GET: (request: Request) => userBlockListRouteResponse({ dependencies, request }),
  };
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
