import 'server-only';
import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { logBackendRouteError } from '@/lib/backend-logger';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import {
  BackendRateLimitError,
  SHOWCASE_FEED_EVENT_RATE_LIMIT,
  SHOWCASE_FEED_EVENT_NETWORK_ADMISSION_RATE_LIMIT,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { readBoundedJsonBody } from '@/lib/bounded-json-request';
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
  readBoundedJsonBody?: typeof readBoundedJsonBody;
  recordShowcaseFeedEvent?: typeof recordShowcaseFeedEvent;
  recordShowcaseFeedEvents?: typeof recordShowcaseFeedEvents;
  logError?: typeof logBackendRouteError;
};

// A full 25-event batch with valid 4 KiB metadata fits comfortably while
// oversized ignored fields and malformed telemetry remain bounded.
export const SHOWCASE_FEED_EVENT_REQUEST_BODY_MAX_BYTES = 128 * 1024;

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
    readBoundedJsonBody: dependencies?.readBoundedJsonBody ?? readBoundedJsonBody,
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
    const { data: { user }, error } = await getVerifiedAuthUserResult(dependencies.createUserClient(request));
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
    const admissionAnonymousIdentity = request.headers.get('Authorization')
      ? null
      : dependencies.resolveFeedAnonymousIdentity(request);
    const serviceClient = dependencies.createServiceClient();

    try {
      await dependencies.enforceBackendRateLimit(serviceClient, {
        ...SHOWCASE_FEED_EVENT_NETWORK_ADMISSION_RATE_LIMIT,
        key: dependencies.getFeedNetworkKeyHash(request),
      });
    } catch (error) {
      if (error instanceof BackendRateLimitError) {
        return attachAnonymousFeedCookie(
          createBackendRateLimitResponse(error),
          admissionAnonymousIdentity,
        );
      }
      dependencies.logError('Showcase feed event rate limit failed:', error);
      return NextResponse.json({ error: 'Failed to check feed event limits.' }, { status: 500 });
    }

    const boundedBody = await dependencies.readBoundedJsonBody(
      request,
      SHOWCASE_FEED_EVENT_REQUEST_BODY_MAX_BYTES,
    );
    if (!boundedBody.ok) {
      return NextResponse.json({
        error: boundedBody.reason === 'too_large'
          ? 'Feed event payload is too large.'
          : 'Invalid JSON payload.',
      }, { status: boundedBody.reason === 'too_large' ? 413 : 400 });
    }

    const parsed = dependencies.parseShowcaseFeedEventBatchPayload(boundedBody.value);
    if (!parsed.ok) return NextResponse.json(parsed.body, { status: parsed.status });

    const actor = await getOptionalActorUserId(request, dependencies);
    if (!actor.ok) {
      return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
    }

    const actorUserId = actor.actorUserId;
    const anonymousIdentity = actorUserId ? null : admissionAnonymousIdentity;
    const anonymousKeyHash = anonymousIdentity?.anonymousKeyHash
      ?? dependencies.getFeedAnonymousKeyHash(request);

    // Restore the original per-account budget for authenticated viewers. The
    // coarse network check above protects parsing, but must not merge unrelated
    // accounts behind a carrier or office NAT into one ordinary-use budget.
    // Anonymous traffic is already network-scoped, so charging it again here
    // would spend two counters for one request without adding isolation.
    if (actorUserId) {
      try {
        await dependencies.enforceBackendRateLimit(serviceClient, {
          ...SHOWCASE_FEED_EVENT_RATE_LIMIT,
          key: actorUserId,
        });
      } catch (error) {
        if (error instanceof BackendRateLimitError) {
          return createBackendRateLimitResponse(error);
        }
        dependencies.logError('Showcase feed actor event rate limit failed:', error);
        return NextResponse.json({ error: 'Failed to check feed event limits.' }, { status: 500 });
      }
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
