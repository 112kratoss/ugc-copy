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
import { isGuestUser } from '@/lib/account-identity';
import { HOME_SHELF_SCHEMA_VERSION } from '@/lib/home-shelf';
import {
  HomeShelfUnavailableError,
  loadHomeShelfForApi,
  type HomeShelfApiItem,
  type HomeShelfIdentity,
} from '@/lib/home-shelf-server';
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
 * is offered what a signed-out visitor is. A token whose user cannot be read is
 * not answered as signed out: that answer skips the viewer's blocks and feed
 * choices, so the route fails instead.
 */
async function readViewer(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
): Promise<HomeShelfIdentity> {
  if (!request.headers.get('Authorization')) return { viewerUserId: null, isAnonymous: false };

  const {
    data: { user },
  } = await getVerifiedAuthUserResult(dependencies.createUserClient(request));
  if (!user) throw new HomeShelfUnavailableError('The shelf viewer could not be read.');
  return { viewerUserId: user.id, isAnonymous: isGuestUser(user) };
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
    // guest's or a member's leaves out what that viewer took out of the feed
    // (and a member's carries their own offers), so it is never shared.
    return NextResponse.json(body, {
      headers: createApiResponseHeaders(request, getViewerAwareApiCacheControl(hasAuthorizationHeader), {
        vary: ['Authorization'],
      }),
    });
  } catch (error) {
    dependencies.logError('Home shelf error:', error);
    // Never kept, at the edge or in the app: an empty shelf answered for a
    // failed read would be served as the shelf until it expired.
    return NextResponse.json(
      { error: 'Failed to load the shelf.' },
      {
        status: error instanceof HomeShelfUnavailableError ? 503 : 500,
        headers: { 'Cache-Control': 'no-store' },
      },
    );
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
