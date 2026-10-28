import 'server-only';
import { logBackendRouteError } from '@/lib/backend-logger';

import { NextResponse } from 'next/server';

import { createPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { getClientNetworkKey } from '@/lib/client-network-key';
import {
  createGenerationModelQuoteBatch,
  type GenerationModelQuoteBatchServiceResult,
} from '@/lib/generation-model-quote-batch-service';
import { createServiceClient } from '@/lib/server-helpers';

/**
 * A full list is a few hundred bytes a run, so this is several times the longest
 * list a creator sends; anything larger is refused before it is read as JSON.
 */
const MAX_BODY_BYTES = 64 * 1024;

type GenerationModelQuoteBatchRouteDependencies = {
  createGenerationModelQuoteBatch?: typeof createGenerationModelQuoteBatch;
  createServiceClient?: typeof createServiceClient;
  logError?: typeof logBackendRouteError;
};

function getQuotePlatform(request: Request) {
  return request.headers.get('x-magicbooklet-client') === 'mobile' ? 'mobile' as const : 'web' as const;
}

function createBatchErrorResponse(
  request: Request,
  result: GenerationModelQuoteBatchServiceResult & { ok: false },
) {
  const headers = new Headers(createPrivateNoStoreApiResponseHeaders(request));
  if (result.retryAfterSeconds !== undefined) headers.set('Retry-After', String(result.retryAfterSeconds));
  if (result.limit !== undefined) headers.set('X-RateLimit-Limit', String(result.limit));
  if (result.remaining !== undefined) headers.set('X-RateLimit-Remaining', String(result.remaining));
  if (result.resetAt) headers.set('X-RateLimit-Reset', result.resetAt);

  return NextResponse.json({
    code: result.code,
    error: result.error,
    fieldErrors: result.fieldErrors,
    ...(result.retryAfterSeconds !== undefined ? { retryAfterSeconds: result.retryAfterSeconds } : {}),
    ...(result.limit !== undefined ? { limit: result.limit } : {}),
    ...(result.resetAt ? { resetAt: result.resetAt } : {}),
  }, { status: result.status, headers });
}

function createInvalidBatchResponse(request: Request, status = 422) {
  return NextResponse.json(
    { code: 'INVALID_QUOTE_BATCH', error: 'The quote request could not be processed.', fieldErrors: {} },
    { status, headers: createPrivateNoStoreApiResponseHeaders(request) },
  );
}

/** `POST /api/generation-models/quotes`: many runs priced in one request (`createGenerationModelQuoteBatch`). */
export async function postGenerationModelQuoteBatchRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: GenerationModelQuoteBatchRouteDependencies;
  request: Request;
}) {
  const createBatch = dependencies?.createGenerationModelQuoteBatch ?? createGenerationModelQuoteBatch;
  const createClient = dependencies?.createServiceClient ?? createServiceClient;
  const logError = dependencies?.logError ?? logBackendRouteError;

  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_BODY_BYTES) return createInvalidBatchResponse(request, 413);

  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return createInvalidBatchResponse(request, 413);
    const result = await createBatch({
      body: JSON.parse(text) as unknown,
      rateLimitKey: getClientNetworkKey(request.headers),
      rateLimitClient: createClient(),
      platform: getQuotePlatform(request),
    });

    if (!result.ok) return createBatchErrorResponse(request, result);
    return NextResponse.json({ quotes: result.quotes }, { headers: createPrivateNoStoreApiResponseHeaders(request) });
  } catch (error) {
    // A body that is not JSON is the caller's; anything else is logged.
    if (!(error instanceof SyntaxError)) logError('Generation model quote batch failed:', error);
    return createInvalidBatchResponse(request);
  }
}
