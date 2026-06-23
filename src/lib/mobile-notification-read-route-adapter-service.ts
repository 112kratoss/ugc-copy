import 'server-only';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { createBackendRateLimitResponse } from '@/lib/backend-rate-limit';
import {
  markAllMobileNotificationsReadForRoute,
  markMobileNotificationsReadForRoute,
  type MobileNotificationInboxRouteResult,
} from '@/lib/mobile-notification-inbox-service';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type MobileNotificationReadRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  markAllMobileNotificationsReadForRoute?: typeof markAllMobileNotificationsReadForRoute;
  markMobileNotificationsReadForRoute?: typeof markMobileNotificationsReadForRoute;
};

function resolveDependencies(dependencies: MobileNotificationReadRouteDependencies = {}) {
  return {
    createServiceClient: dependencies.createServiceClient ?? createServiceClient,
    createUserClient: dependencies.createUserClient ?? createUserClient,
    markAllMobileNotificationsReadForRoute:
      dependencies.markAllMobileNotificationsReadForRoute ?? markAllMobileNotificationsReadForRoute,
    markMobileNotificationsReadForRoute:
      dependencies.markMobileNotificationsReadForRoute ?? markMobileNotificationsReadForRoute,
  };
}

function toJsonResponse(result: MobileNotificationInboxRouteResult) {
  if (!result.ok && result.rateLimitError) {
    return createBackendRateLimitResponse(result.rateLimitError);
  }

  return NextResponse.json(result.body, { status: result.ok ? 200 : result.status });
}

async function handleMobileNotificationReadPOST({
  dependencies: routeDependencies,
  request,
}: {
  dependencies?: MobileNotificationReadRouteDependencies;
  request: Request;
}) {
  const dependencies = resolveDependencies(routeDependencies);

  return toJsonResponse(await dependencies.markMobileNotificationsReadForRoute({
    getAdminSupabase: dependencies.createServiceClient,
    readRequestBody: () => request.json(),
    userSupabase: dependencies.createUserClient(request),
  }));
}

async function handleMobileNotificationReadAllPOST({
  dependencies: routeDependencies,
  request,
}: {
  dependencies?: MobileNotificationReadRouteDependencies;
  request: Request;
}) {
  const dependencies = resolveDependencies(routeDependencies);

  return toJsonResponse(await dependencies.markAllMobileNotificationsReadForRoute({
    getAdminSupabase: dependencies.createServiceClient,
    userSupabase: dependencies.createUserClient(request),
  }));
}

export async function postMobileNotificationReadRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: MobileNotificationReadRouteDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handleMobileNotificationReadPOST({ dependencies, request }),
    request,
  );
}

export async function postMobileNotificationReadAllRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: MobileNotificationReadRouteDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handleMobileNotificationReadAllPOST({ dependencies, request }),
    request,
  );
}
