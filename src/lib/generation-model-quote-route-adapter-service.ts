import 'server-only';
import { logBackendRouteError } from '@/lib/backend-logger';

import { NextResponse } from 'next/server';

import { createPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { getClientNetworkKey } from '@/lib/client-network-key';
import type { GenerationModelQuoteInput } from '@/lib/generation-model-catalog';
import { createGenerationModelQuote } from '@/lib/generation-model-quote-service';
import { createQuoteErrorResponse, getQuotePlatform } from '@/lib/generation-model-quote-route-shared';
import { createServiceClient } from '@/lib/server-helpers';

type GenerationModelQuoteRouteDependencies = {
  createGenerationModelQuote?: typeof createGenerationModelQuote;
  createServiceClient?: typeof createServiceClient;
  logError?: typeof logBackendRouteError;
};

function resolveDependencies(dependencies: GenerationModelQuoteRouteDependencies | undefined) {
  return {
    createGenerationModelQuote: dependencies?.createGenerationModelQuote ?? createGenerationModelQuote,
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    logError: dependencies?.logError ?? logBackendRouteError,
  };
}

function getQuoteRateLimitKey(request: Request) {
  return getClientNetworkKey(request.headers);
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
