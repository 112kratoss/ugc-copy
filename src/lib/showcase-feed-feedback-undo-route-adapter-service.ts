import 'server-only';
import { logBackendRouteError } from '@/lib/backend-logger';

import { NextResponse } from 'next/server';

import { requireIdentity } from '@/lib/account-identity';
import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import {
  BackendRateLimitError,
  SHOWCASE_FEED_EVENT_RATE_LIMIT,
  createBackendRateLimitResponse,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { readBoundedJsonBody } from '@/lib/bounded-json-request';
import {
  parseShowcaseFeedFeedbackUndoPayload,
  undoShowcaseFeedFeedback,
} from '@/lib/showcase-feed-events-service';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type ShowcaseFeedFeedbackUndoRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  readBoundedJsonBody?: typeof readBoundedJsonBody;
  requireIdentity?: typeof requireIdentity;
  undoShowcaseFeedFeedback?: typeof undoShowcaseFeedFeedback;
  logError?: typeof logBackendRouteError;
};

// The body names one post or one creator, under 120 bytes. The bound leaves
// room for whitespace and an extra field, and nothing like an events batch.
export const SHOWCASE_FEED_FEEDBACK_UNDO_REQUEST_BODY_MAX_BYTES = 2 * 1024;

function resolveDependencies(dependencies: ShowcaseFeedFeedbackUndoRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    enforceBackendRateLimit: dependencies?.enforceBackendRateLimit ?? enforceBackendRateLimit,
    readBoundedJsonBody: dependencies?.readBoundedJsonBody ?? readBoundedJsonBody,
    requireIdentity: dependencies?.requireIdentity ?? requireIdentity,
    undoShowcaseFeedFeedback: dependencies?.undoShowcaseFeedFeedback ?? undoShowcaseFeedFeedback,
    logError: dependencies?.logError ?? logBackendRouteError,
  };
}

async function handleShowcaseFeedFeedbackUndoPOST(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  try {
    // The rows an undo deletes are kept under a user id, and identity comes
    // from the bearer token exactly as the events route that wrote them reads
    // it: the app's guest holds an anonymous session and counts (D1). The
    // web's cookie-hash guest has no row to take back and undoes locally.
    if (!request.headers.get('Authorization')) {
      return NextResponse.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, { status: 401 });
    }

    const serviceClient = dependencies.createServiceClient();
    const identity = await dependencies.requireIdentity(
      dependencies.createUserClient(request),
      serviceClient,
    );
    if (!identity.ok) {
      return NextResponse.json(
        { error: identity.error, code: identity.code },
        { status: identity.status },
      );
    }
    const actorUserId = identity.identity.userId;

    // The per-account budget of the feed events this takes back, charged
    // before the body is read so a stream of bad bodies is limited too.
    try {
      await dependencies.enforceBackendRateLimit(serviceClient, {
        ...SHOWCASE_FEED_EVENT_RATE_LIMIT,
        key: actorUserId,
      });
    } catch (error) {
      if (error instanceof BackendRateLimitError) {
        return createBackendRateLimitResponse(error);
      }
      dependencies.logError('Showcase feed feedback undo rate limit failed:', error);
      return NextResponse.json({ error: 'Failed to check feed event limits.' }, { status: 500 });
    }

    const boundedBody = await dependencies.readBoundedJsonBody(
      request,
      SHOWCASE_FEED_FEEDBACK_UNDO_REQUEST_BODY_MAX_BYTES,
    );
    if (!boundedBody.ok) {
      return NextResponse.json({
        error: boundedBody.reason === 'too_large'
          ? 'Feed preference undo payload is too large.'
          : 'Invalid JSON payload.',
      }, { status: boundedBody.reason === 'too_large' ? 413 : 400 });
    }

    const parsed = parseShowcaseFeedFeedbackUndoPayload(boundedBody.value);
    if (!parsed.ok) return NextResponse.json(parsed.body, { status: parsed.status });

    const result = await dependencies.undoShowcaseFeedFeedback({
      actorUserId,
      serviceClient,
      target: parsed.target,
    });
    return NextResponse.json(result.body, { status: result.ok ? 200 : result.status });
  } catch (error) {
    dependencies.logError('Showcase feed feedback undo failed:', error);
    return NextResponse.json({ error: 'Failed to undo the feed preference.' }, { status: 500 });
  }
}

export async function postShowcaseFeedFeedbackUndoRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: ShowcaseFeedFeedbackUndoRouteDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handleShowcaseFeedFeedbackUndoPOST(request, resolveDependencies(dependencies)),
    request,
  );
}
