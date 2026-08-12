import 'server-only';
import { logBackendRouteError } from '@/lib/backend-logger';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import {
  BackendRateLimitError,
  SHOWCASE_FEED_EVENT_RATE_LIMIT,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import {
  getFeedAnonymousKeyHash,
  parseShowcaseFeedEventBatchPayload,
  recordShowcaseFeedEvent,
  recordShowcaseFeedEvents,
} from '@/lib/showcase-feed-events-service';
import {
  FEED_ANONYMOUS_COOKIE_MAX_AGE_SECONDS,
  FEED_ANONYMOUS_COOKIE_NAME,
  getFeedNetworkKeyHash,
  resolveFeedAnonymousIdentity,
  type FeedAnonymousIdentity,
} from '@/lib/showcase-feed-identity';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type ShowcaseFeedEventsRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  getFeedAnonymousKeyHash?: typeof getFeedAnonymousKeyHash;
  getFeedNetworkKeyHash?: typeof getFeedNetworkKeyHash;
  resolveFeedAnonymousIdentity?: typeof resolveFeedAnonymousIdentity;
  parseShowcaseFeedEventBatchPayload?: typeof parseShowcaseFeedEventBatchPayload;
  recordShowcaseFeedEvent?: typeof recordShowcaseFeedEvent;
  recordShowcaseFeedEvents?: typeof recordShowcaseFeedEvents;
  logError?: typeof logBackendRouteError;
};

function resolveDependencies(dependencies: ShowcaseFeedEventsRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    enforceBackendRateLimit: dependencies?.enforceBackendRateLimit ?? enforceBackendRateLimit,
    getFeedAnonymousKeyHash: dependencies?.getFeedAnonymousKeyHash ?? getFeedAnonymousKeyHash,
    getFeedNetworkKeyHash: dependencies?.getFeedNetworkKeyHash ?? getFeedNetworkKeyHash,
    resolveFeedAnonymousIdentity: dependencies?.resolveFeedAnonymousIdentity ?? resolveFeedAnonymousIdentity,
    parseShowcaseFeedEventBatchPayload:
      dependencies?.parseShowcaseFeedEventBatchPayload ?? parseShowcaseFeedEventBatchPayload,
    recordShowcaseFeedEvent: dependencies?.recordShowcaseFeedEvent ?? recordShowcaseFeedEvent,
    recordShowcaseFeedEvents: dependencies?.recordShowcaseFeedEvents ?? recordShowcaseFeedEvents,
    logError: dependencies?.logError ?? logBackendRouteError,
  };
}

function attachAnonymousFeedCookie(response: NextResponse, identity: FeedAnonymousIdentity | null) {
  if (!identity?.cookieValueToSet) return response;
  response.cookies.set({
    name: FEED_ANONYMOUS_COOKIE_NAME,
    value: identity.cookieValueToSet,
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: FEED_ANONYMOUS_COOKIE_MAX_AGE_SECONDS,
  });
  return response;
}

async function getOptionalActorUserId(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  if (!request.headers.get('Authorization')) {
    return { ok: true as const, actorUserId: null };
  }

  try {
    const { data: { user }, error } = await dependencies.createUserClient(request).auth.getUser();
    if (error || !user?.id) {
      return { ok: false as const };
    }
    return { ok: true as const, actorUserId: user.id };
  } catch {
    return { ok: false as const };
  }
}

async function handleShowcaseFeedEventPOST(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  try {
    const parsed = dependencies.parseShowcaseFeedEventBatchPayload(await request.json());
    if (!parsed.ok) return NextResponse.json(parsed.body, { status: parsed.status });

    const actor = await getOptionalActorUserId(request, dependencies);
    if (!actor.ok) {
      return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
    }

    const actorUserId = actor.actorUserId;
    const anonymousIdentity = actorUserId ? null : dependencies.resolveFeedAnonymousIdentity(request);
    const anonymousKeyHash = anonymousIdentity?.anonymousKeyHash
      ?? dependencies.getFeedAnonymousKeyHash(request);
    const serviceClient = dependencies.createServiceClient();

    try {
      await dependencies.enforceBackendRateLimit(serviceClient, {
        ...SHOWCASE_FEED_EVENT_RATE_LIMIT,
        key: actorUserId ?? dependencies.getFeedNetworkKeyHash(request),
      });
    } catch (error) {
      if (error instanceof BackendRateLimitError) {
        return attachAnonymousFeedCookie(createBackendRateLimitResponse(error), anonymousIdentity);
      }
      dependencies.logError('Showcase feed event rate limit failed:', error);
      return NextResponse.json({ error: 'Failed to check feed event limits.' }, { status: 500 });
    }

    if (!parsed.batched) {
      const result = await dependencies.recordShowcaseFeedEvent({
        actorUserId,
        anonymousKeyHash,
        payload: parsed.payloads[0],
        serviceClient,
      });
      // Answer a single-event request exactly as before. Mobile builds sending
      // one event per request stay in the wild for as long as their store train
      // takes, and they parse this body.
      return attachAnonymousFeedCookie(
        NextResponse.json(result.body, { status: result.ok ? 200 : result.status }),
        anonymousIdentity,
      );
    }

    // Auth, rate limiting and persistence each happen once for the entire
    // batch. The RPC returns mixed outcomes after isolating poison entries with
    // nested savepoints; transport/schema failures are retryable 500s and never
    // fall back to the old serial path.
    const result = await dependencies.recordShowcaseFeedEvents({
      actorUserId,
      anonymousKeyHash,
      payloads: parsed.payloads,
      serviceClient,
    });
    if (!result.ok) {
      return attachAnonymousFeedCookie(
        NextResponse.json(result.body, { status: result.status }),
        anonymousIdentity,
      );
    }
    return attachAnonymousFeedCookie(
      NextResponse.json(result.body),
      anonymousIdentity,
    );
  } catch (error) {
    dependencies.logError('Showcase feed event failed:', error);
    return NextResponse.json({ error: 'Failed to record feed event.' }, { status: 500 });
  }
}

export async function postShowcaseFeedEventRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: ShowcaseFeedEventsRouteDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handleShowcaseFeedEventPOST(request, resolveDependencies(dependencies)),
    request,
  );
}
