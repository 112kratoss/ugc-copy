import 'server-only';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { createBackendRateLimitResponse } from '@/lib/backend-rate-limit';
import {
  getMobileNotificationPreferencesForRoute,
  updateMobileNotificationPreferencesForRoute,
  type MobileNotificationPreferencesRouteResult,
} from '@/lib/mobile-notification-preferences-service';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type MobileNotificationPreferencesRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  getMobileNotificationPreferencesForRoute?: typeof getMobileNotificationPreferencesForRoute;
  updateMobileNotificationPreferencesForRoute?: typeof updateMobileNotificationPreferencesForRoute;
};

function resolveDependencies(dependencies: MobileNotificationPreferencesRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    getMobileNotificationPreferencesForRoute:
      dependencies?.getMobileNotificationPreferencesForRoute ?? getMobileNotificationPreferencesForRoute,
    updateMobileNotificationPreferencesForRoute:
      dependencies?.updateMobileNotificationPreferencesForRoute ?? updateMobileNotificationPreferencesForRoute,
  };
}

function toJsonResponse(result: MobileNotificationPreferencesRouteResult) {
  if (!result.ok && result.rateLimitError) {
    return createBackendRateLimitResponse(result.rateLimitError);
  }

  return NextResponse.json(result.body, { status: result.ok ? 200 : result.status });
}

async function handleMobileNotificationPreferencesGET(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  return toJsonResponse(await dependencies.getMobileNotificationPreferencesForRoute({
    userSupabase: dependencies.createUserClient(request),
  }));
}

async function handleMobileNotificationPreferencesPATCH(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  return toJsonResponse(await dependencies.updateMobileNotificationPreferencesForRoute({
    getAdminSupabase: dependencies.createServiceClient,
    readRequestBody: () => request.json(),
    userSupabase: dependencies.createUserClient(request),
  }));
}

export async function getMobileNotificationPreferencesRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: MobileNotificationPreferencesRouteDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handleMobileNotificationPreferencesGET(request, resolveDependencies(dependencies)),
    request,
  );
}

export async function patchMobileNotificationPreferencesRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: MobileNotificationPreferencesRouteDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handleMobileNotificationPreferencesPATCH(request, resolveDependencies(dependencies)),
    request,
  );
}

export function createMobileNotificationPreferencesRouteHandlers({
  dependencies,
}: {
  dependencies?: MobileNotificationPreferencesRouteDependencies;
} = {}) {
  return {
    GET(request: Request) {
      return getMobileNotificationPreferencesRouteResponse({ dependencies, request });
    },
    PATCH(request: Request) {
      return patchMobileNotificationPreferencesRouteResponse({ dependencies, request });
    },
  };
}
