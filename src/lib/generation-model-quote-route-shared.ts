import 'server-only';

import { NextResponse } from 'next/server';

import { createPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import type { GenerationModelQuoteRefusal } from '@/lib/generation-model-quote-service';

/**
 * What the single quote (`/api/generation-models/quote`) and the batch
 * (`/api/generation-models/quotes`) answer alike, so the two cannot drift: the platform a
 * request prices for, and a refusal with its rate-limit headers.
 */

export function getQuotePlatform(request: Request) {
  return request.headers.get('x-magicbooklet-client') === 'mobile' ? 'mobile' as const : 'web' as const;
}

export function createQuoteErrorResponse(request: Request, result: GenerationModelQuoteRefusal) {
  const headers = new Headers(createPrivateNoStoreApiResponseHeaders(request));
  if (result.retryAfterSeconds !== undefined) {
    headers.set('Retry-After', String(result.retryAfterSeconds));
  }
  if (result.limit !== undefined) {
    headers.set('X-RateLimit-Limit', String(result.limit));
  }
  if (result.remaining !== undefined) {
    headers.set('X-RateLimit-Remaining', String(result.remaining));
  }
  if (result.resetAt) {
    headers.set('X-RateLimit-Reset', result.resetAt);
  }

  return NextResponse.json({
    code: result.code,
    error: result.error,
    fieldErrors: result.fieldErrors,
    ...(result.retryAfterSeconds !== undefined ? { retryAfterSeconds: result.retryAfterSeconds } : {}),
    ...(result.limit !== undefined ? { limit: result.limit } : {}),
    ...(result.resetAt ? { resetAt: result.resetAt } : {}),
  }, { status: result.status, headers });
}
