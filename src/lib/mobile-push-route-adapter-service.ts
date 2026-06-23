import 'server-only';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { createBackendRateLimitResponse } from '@/lib/backend-rate-limit';
import {
  registerMobilePushTokenForRoute,
  type MobilePushRegistrationRouteResult,
} from '@/lib/mobile-push-registration-service';
import {
  unregisterMobilePushTokenForRoute,
  type MobilePushUnregisterRouteResult,
} from '@/lib/mobile-push-unregister-service';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type MobilePushRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  registerMobilePushTokenForRoute?: typeof registerMobilePushTokenForRoute;
  unregisterMobilePushTokenForRoute?: typeof unregisterMobilePushTokenForRoute;
};

function resolveDependencies(dependencies: MobilePushRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    registerMobilePushTokenForRoute:
      dependencies?.registerMobilePushTokenForRoute ?? registerMobilePushTokenForRoute,
    unregisterMobilePushTokenForRoute:
      dependencies?.unregisterMobilePushTokenForRoute ?? unregisterMobilePushTokenForRoute,
  };
}

function toJsonResponse(result: MobilePushRegistrationRouteResult | MobilePushUnregisterRouteResult) {
  if (!result.ok && result.rateLimitError) {
    return createBackendRateLimitResponse(result.rateLimitError);
  }

  return NextResponse.json(result.body, { status: result.ok ? 200 : result.status });
}

async function handleMobilePushRegisterPOST(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  return toJsonResponse(await dependencies.registerMobilePushTokenForRoute({
    getAdminSupabase: dependencies.createServiceClient,
    readRequestBody: () => request.json(),
    userSupabase: dependencies.createUserClient(request),
  }));
}

async function handleMobilePushUnregisterPOST(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  return toJsonResponse(await dependencies.unregisterMobilePushTokenForRoute({
    getAdminSupabase: dependencies.createServiceClient,
    readRequestBody: () => request.json(),
    userSupabase: dependencies.createUserClient(request),
  }));
}

export async function postMobilePushRegisterRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: MobilePushRouteDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handleMobilePushRegisterPOST(request, resolveDependencies(dependencies)),
    request,
  );
}

export async function postMobilePushUnregisterRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: MobilePushRouteDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handleMobilePushUnregisterPOST(request, resolveDependencies(dependencies)),
    request,
  );
}
