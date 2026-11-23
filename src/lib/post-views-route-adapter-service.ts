import 'server-only';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { logBackendRouteError } from '@/lib/backend-logger';
import {
  BackendRateLimitError,
  POST_VIEW_NETWORK_ADMISSION_RATE_LIMIT,
  POST_VIEW_RATE_LIMIT,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { readBoundedJsonBody } from '@/lib/bounded-json-request';
import { parsePostViewsPayload, recordPostViews } from '@/lib/post-views-service';
import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';
import { getFeedNetworkKeyHash, resolveFeedAnonymousIdentity } from '@/lib/showcase-feed-identity';

/** 25 views of about 80 bytes each, with room to spare. */
export const POST_VIEWS_REQUEST_BODY_MAX_BYTES = 8 * 1024;

type PostViewsRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  getFeedNetworkKeyHash?: typeof getFeedNetworkKeyHash;
  resolveFeedAnonymousIdentity?: typeof resolveFeedAnonymousIdentity;
  readBoundedJsonBody?: typeof readBoundedJsonBody;
  recordPostViews?: typeof recordPostViews;
  logError?: typeof logBackendRouteError;
};

function resolveDependencies(dependencies: PostViewsRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    enforceBackendRateLimit: dependencies?.enforceBackendRateLimit ?? enforceBackendRateLimit,
    getFeedNetworkKeyHash: dependencies?.getFeedNetworkKeyHash ?? getFeedNetworkKeyHash,
    resolveFeedAnonymousIdentity: dependencies?.resolveFeedAnonymousIdentity ?? resolveFeedAnonymousIdentity,
    readBoundedJsonBody: dependencies?.readBoundedJsonBody ?? readBoundedJsonBody,
    recordPostViews: dependencies?.recordPostViews ?? recordPostViews,
    logError: dependencies?.logError ?? logBackendRouteError,
  };
}

type ResolvedDependencies = ReturnType<typeof resolveDependencies>;

/**
 * Only `application/json`: another site's page cannot send that without a
 * preflight this API never answers, so it cannot add views from its visitors'
 * browsers.
 */
function isJsonRequest(request: Request) {
  const contentType = request.headers.get('content-type') ?? '';
  return contentType.split(';')[0]?.trim().toLowerCase() === 'application/json';
}

/**
 * A guest is its app's installation id or its browser's feed cookie, as the
 * feed knows it. A request with neither counts by its network, never by an id
 * minted here: a fresh id per request would make every cookie-less request a
 * new viewer. No cookie is set: the feed sets it.
 */
function resolveGuestKey(request: Request, dependencies: ResolvedDependencies, networkKeyHash: string) {
  const identity = dependencies.resolveFeedAnonymousIdentity(request);
  return identity.cookieValueToSet ? networkKeyHash : identity.anonymousKeyHash;
}

async function getOptionalActorUserId(request: Request, dependencies: ResolvedDependencies) {
  if (!request.headers.get('Authorization')) {
    return { ok: true as const, actorUserId: null };
  }
  try {
    const { data: { user }, error } = await getVerifiedAuthUserResult(dependencies.createUserClient(request));
    if (error || !user?.id) return { ok: false as const };
    return { ok: true as const, actorUserId: user.id };
  } catch {
    return { ok: false as const };
  }
}

async function handlePostViewsPOST(request: Request, dependencies: ResolvedDependencies) {
  try {
    if (!isJsonRequest(request)) {
      return NextResponse.json({ error: 'Post views must be sent as JSON.' }, { status: 400 });
    }

    const serviceClient = dependencies.createServiceClient();
    const networkKeyHash = dependencies.getFeedNetworkKeyHash(request);

    try {
      await dependencies.enforceBackendRateLimit(serviceClient, {
        ...POST_VIEW_NETWORK_ADMISSION_RATE_LIMIT,
        key: networkKeyHash,
      });
    } catch (error) {
      if (error instanceof BackendRateLimitError) return createBackendRateLimitResponse(error);
      dependencies.logError('Post views rate limit failed:', error);
      return NextResponse.json({ error: 'Failed to check post view limits.' }, { status: 500 });
    }

    const boundedBody = await dependencies.readBoundedJsonBody(request, POST_VIEWS_REQUEST_BODY_MAX_BYTES);
    if (!boundedBody.ok) {
      return NextResponse.json({
        error: boundedBody.reason === 'too_large' ? 'Post views payload is too large.' : 'Invalid JSON payload.',
      }, { status: boundedBody.reason === 'too_large' ? 413 : 400 });
    }

    const parsed = parsePostViewsPayload(boundedBody.value);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

    const actor = await getOptionalActorUserId(request, dependencies);
    if (!actor.ok) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });

    // An account has a budget of its own, so viewers behind one address are
    // not one budget; a guest is already held by the network's.
    if (actor.actorUserId) {
      try {
        await dependencies.enforceBackendRateLimit(serviceClient, {
          ...POST_VIEW_RATE_LIMIT,
          key: actor.actorUserId,
        });
      } catch (error) {
        if (error instanceof BackendRateLimitError) return createBackendRateLimitResponse(error);
        dependencies.logError('Post views account rate limit failed:', error);
        return NextResponse.json({ error: 'Failed to check post view limits.' }, { status: 500 });
      }
    }

    await dependencies.recordPostViews(serviceClient, {
      viewerUserId: actor.actorUserId,
      anonymousKeyHash: actor.actorUserId ? null : resolveGuestKey(request, dependencies, networkKeyHash),
      networkKeyHash,
      views: parsed.views,
    });

    // The same answer whatever was counted: it says nothing about which
    // posts exist, can be seen or were already viewed today.
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    dependencies.logError('Post views failed:', error);
    return NextResponse.json({ error: 'Failed to record post views.' }, { status: 500 });
  }
}

export async function postPostViewsRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: PostViewsRouteDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handlePostViewsPOST(request, resolveDependencies(dependencies)),
    request,
  );
}
