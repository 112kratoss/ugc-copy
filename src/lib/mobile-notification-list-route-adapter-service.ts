import 'server-only';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import {
  getMobileNotificationInboxForRoute,
  type MobileNotificationInboxRouteResult,
} from '@/lib/mobile-notification-inbox-service';
import { createUserClient } from '@/lib/server-helpers';

type MobileNotificationListRouteDependencies = {
  createUserClient?: typeof createUserClient;
  getMobileNotificationInboxForRoute?: typeof getMobileNotificationInboxForRoute;
};

function resolveDependencies(dependencies: MobileNotificationListRouteDependencies = {}) {
  return {
    createUserClient: dependencies.createUserClient ?? createUserClient,
    getMobileNotificationInboxForRoute:
      dependencies.getMobileNotificationInboxForRoute ?? getMobileNotificationInboxForRoute,
  };
}

function toJsonResponse(result: MobileNotificationInboxRouteResult) {
  return NextResponse.json(result.body, { status: result.ok ? 200 : result.status });
}

export async function getMobileNotificationListRouteResponse({
  dependencies: routeDependencies,
  request,
}: {
  dependencies?: MobileNotificationListRouteDependencies;
  request: Request;
}) {
  const dependencies = resolveDependencies(routeDependencies);
  const searchParams = new URL(request.url).searchParams;

  return applyPrivateNoStoreApiResponseHeaders(
    toJsonResponse(await dependencies.getMobileNotificationInboxForRoute({
      before: searchParams.get('before'),
      limitValue: searchParams.get('limit'),
      userSupabase: dependencies.createUserClient(request),
    })),
    request,
  );
}
