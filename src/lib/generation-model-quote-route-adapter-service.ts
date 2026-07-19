import 'server-only';

import { NextResponse } from 'next/server';

import { createPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import type { GenerationModelQuoteInput } from '@/lib/generation-model-catalog';
import {
  createGenerationModelQuote,
  type GenerationModelQuoteServiceResult,
} from '@/lib/generation-model-quote-service';
import { createServiceClient } from '@/lib/server-helpers';

type GenerationModelQuoteRouteDependencies = {
  createGenerationModelQuote?: typeof createGenerationModelQuote;
  createServiceClient?: typeof createServiceClient;
  logError?: typeof console.error;
};

function resolveDependencies(dependencies: GenerationModelQuoteRouteDependencies | undefined) {
  return {
    createGenerationModelQuote: dependencies?.createGenerationModelQuote ?? createGenerationModelQuote,
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    logError: dependencies?.logError ?? console.error,
  };
}

function getQuoteRateLimitKey(request: Request) {
  const forwardedFor = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const realIp = request.headers.get('x-real-ip')?.trim();

  return forwardedFor || realIp || '127.0.0.1';
}

function getQuotePlatform(request: Request) {
  return request.headers.get('x-magicbooklet-client') === 'mobile' ? 'mobile' as const : 'web' as const;
}

function createQuoteErrorResponse(
  request: Request,
  result: GenerationModelQuoteServiceResult & { ok: false },
) {
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

function createInvalidQuoteRequestResponse(request: Request) {
  return NextResponse.json(
    { code: 'INVALID_MODEL_SETTINGS', error: 'The quote request could not be processed.', fieldErrors: {} },
    { status: 422, headers: createPrivateNoStoreApiResponseHeaders(request) },
  );
}

export async function postGenerationModelQuoteRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: GenerationModelQuoteRouteDependencies;
  request: Request;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);

  try {
    const body = await request.json() as Partial<GenerationModelQuoteInput>;
    const result = await resolvedDependencies.createGenerationModelQuote({
      body,
      rateLimitKey: getQuoteRateLimitKey(request),
      rateLimitClient: resolvedDependencies.createServiceClient(),
      platform: getQuotePlatform(request),
    });

    if (!result.ok) {
      return createQuoteErrorResponse(request, result);
    }

    return NextResponse.json(result.quote, { headers: createPrivateNoStoreApiResponseHeaders(request) });
  } catch (error) {
    if (error && typeof error === 'object' && 'message' in error) {
      resolvedDependencies.logError('Generation model quote failed:', error);
    }

    return createInvalidQuoteRequestResponse(request);
  }
}
