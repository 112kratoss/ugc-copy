import 'server-only';
import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { logBackendRouteError } from '@/lib/backend-logger';

import { NextResponse } from 'next/server';

import {
  createApiResponseHeaders,
  getApiRequestId,
  getViewerAwareApiCacheControl,
} from '@/lib/api-cache';
import {
  BackendRateLimitError,
  HOME_SHELF_READ_RATE_LIMIT,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { HOME_SHELF_SCHEMA_VERSION } from '@/lib/home-shelf';
import { loadHomeShelfForApi, type HomeShelfApiItem } from '@/lib/home-shelf-server';
import { withProviderFetchRequestId } from '@/lib/provider-fetch';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';
import { getFeedNetworkKeyHash } from '@/lib/showcase-feed-identity';

export type HomeShelfRouteResponse = {
  success: true;
  schemaVersion: typeof HOME_SHELF_SCHEMA_VERSION;
  items: HomeShelfApiItem[];
};

type HomeShelfRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  getFeedNetworkKeyHash?: typeof getFeedNetworkKeyHash;
  loadHomeShelfForApi?: typeof loadHomeShelfForApi;
  logError?: typeof logBackendRouteError;
  withProviderFetchRequestId?: typeof withProviderFetchRequestId;
};

function resolveDependencies(dependencies: HomeShelfRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    enforceBackendRateLimit: dependencies?.enforceBackendRateLimit ?? enforceBackendRateLimit,
    getFeedNetworkKeyHash: dependencies?.getFeedNetworkKeyHash ?? getFeedNetworkKeyHash,
    loadHomeShelfForApi: dependencies?.loadHomeShelfForApi ?? loadHomeShelfForApi,
    logError: dependencies?.logError ?? logBackendRouteError,
    withProviderFetchRequestId: dependencies?.withProviderFetchRequestId ?? withProviderFetchRequestId,
  };
}

/**
 * The caller as the shelf sees it. No token is a signed-out visitor; a token
 * the proxy admitted is read here once more for its anonymity, since a guest
 * is offered what a signed-out visitor is.
 */
async function readViewer(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
): Promise<{ viewerUserId: string | null; isAnonymous: boolean }> {
  if (!request.headers.get('Authorization')) return { viewerUserId: null, isAnonymous: false };

  const {
    data: { user },
  } = await getVerifiedAuthUserResult(dependencies.createUserClient(request));
  return { viewerUserId: user?.id ?? null, isAnonymous: user?.is_anonymous === true };
}

async function handleHomeShelfGET(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  try {
    const hasAuthorizationHeader = Boolean(request.headers.get('Authorization'));
    const viewer = await readViewer(request, dependencies);

    try {
      await dependencies.enforceBackendRateLimit(dependencies.createServiceClient(), {
        ...HOME_SHELF_READ_RATE_LIMIT,
        key: viewer.viewerUserId ?? dependencies.getFeedNetworkKeyHash(request),
      });
    } catch (error) {
      if (error instanceof BackendRateLimitError) {
        return createBackendRateLimitResponse(error);
      }

      throw error;
    }

    const body: HomeShelfRouteResponse = {
      success: true,
      schemaVersion: HOME_SHELF_SCHEMA_VERSION,
      items: await dependencies.loadHomeShelfForApi(viewer),
    };

    // A signed-out answer is the same for everyone and caches at the edge; a
    // member's carries their own offers, so it is never shared.
    return NextResponse.json(body, {
      headers: createApiResponseHeaders(request, getViewerAwareApiCacheControl(hasAuthorizationHeader), {
        vary: ['Authorization'],
      }),
    });
  } catch (error) {
    dependencies.logError('Home shelf error:', error);
    return NextResponse.json({ error: 'Failed to load the shelf.' }, { status: 500 });
  }
}

export async function getHomeShelfRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: HomeShelfRouteDependencies;
  request: Request;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);
  return resolvedDependencies.withProviderFetchRequestId(getApiRequestId(request), async () => (
    handleHomeShelfGET(request, resolvedDependencies)
  ));
}
