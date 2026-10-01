import 'server-only';

import { after, NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders, getApiRequestId } from '@/lib/api-cache';
import {
  BackendRateLimitError,
  createBackendRateLimitResponse,
} from '@/lib/backend-rate-limit';
import type { RunAfterResponse } from '@/lib/deferrable-notification';
import { withProviderFetchRequestId } from '@/lib/provider-fetch';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type GenerationRouteBody = Record<string, unknown>;

export type GenerationRouteResult =
  | {
      ok: true;
      body: GenerationRouteBody;
    }
  | {
      ok: false;
      body: GenerationRouteBody;
      status: number;
      rateLimitError?: BackendRateLimitError;
    };

export type GenerationRouteOperationInput = {
  createAdminSupabase: typeof createServiceClient;
  createUserSupabase: () => ReturnType<typeof createUserClient>;
  kieApiKey?: string;
  readRequestBody?: () => Promise<unknown>;
  request: Request;
  /** Given to a status check only. A start has nothing to send once it has answered. */
  runAfterResponse?: RunAfterResponse;
};

type GenerationRouteOperation = (
  input: GenerationRouteOperationInput,
) => Promise<GenerationRouteResult>;

type GenerationRouteAdapterDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  runAfterResponse?: RunAfterResponse;
  withProviderFetchRequestId?: typeof withProviderFetchRequestId;
};

function resolveDependencies(dependencies: GenerationRouteAdapterDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    runAfterResponse: dependencies?.runAfterResponse ?? ((task) => after(task)),
    withProviderFetchRequestId:
      dependencies?.withProviderFetchRequestId ?? withProviderFetchRequestId,
  };
}

function createGenerationJsonResponse(result: GenerationRouteResult) {
  if (!result.ok && result.rateLimitError) {
    return createBackendRateLimitResponse(result.rateLimitError);
  }

  return NextResponse.json(result.body, { status: result.ok ? 200 : result.status });
}

async function runGenerationRouteOperation({
  dependencies,
  kieApiKey,
  operation,
  readRequestBody,
  request,
  runAfterResponse,
}: {
  dependencies: ReturnType<typeof resolveDependencies>;
  kieApiKey?: string;
  operation: GenerationRouteOperation;
  readRequestBody?: () => Promise<unknown>;
  request: Request;
  runAfterResponse?: RunAfterResponse;
}) {
  return dependencies.withProviderFetchRequestId(getApiRequestId(request), async () => {
    const response = createGenerationJsonResponse(await operation({
      createAdminSupabase: dependencies.createServiceClient,
      createUserSupabase: () => dependencies.createUserClient(request),
      kieApiKey,
      ...(readRequestBody ? { readRequestBody } : {}),
      request,
      ...(runAfterResponse ? { runAfterResponse } : {}),
    }));

    return applyPrivateNoStoreApiResponseHeaders(response, request);
  });
}

export function postGenerationRouteResponse({
  dependencies,
  kieApiKey,
  postGenerationForRoute,
  request,
}: {
  dependencies?: GenerationRouteAdapterDependencies;
  kieApiKey?: string;
  postGenerationForRoute: GenerationRouteOperation;
  request: Request;
}) {
  return runGenerationRouteOperation({
    dependencies: resolveDependencies(dependencies),
    kieApiKey,
    operation: postGenerationForRoute,
    readRequestBody: () => request.json(),
    request,
  });
}

export function getGenerationRouteResponse({
  dependencies,
  getGenerationForRoute,
  kieApiKey,
  request,
}: {
  dependencies?: GenerationRouteAdapterDependencies;
  getGenerationForRoute: GenerationRouteOperation;
  kieApiKey?: string;
  request: Request;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);

  return runGenerationRouteOperation({
    dependencies: resolvedDependencies,
    kieApiKey,
    operation: getGenerationForRoute,
    request,
    // The app polls this while a generation runs, and waits on each answer to
    // show how it ended. A poll that finds the provider failed it also tells
    // the creator's devices, which is sent once the poll is answered.
    runAfterResponse: resolvedDependencies.runAfterResponse,
  });
}

export function createGenerationRouteHandlers({
  dependencies,
  getGenerationForRoute,
  kieApiKey = process.env.KIE_AI_API_KEY,
  postGenerationForRoute,
}: {
  dependencies?: GenerationRouteAdapterDependencies;
  getGenerationForRoute: GenerationRouteOperation;
  kieApiKey?: string;
  postGenerationForRoute: GenerationRouteOperation;
}) {
  return {
    GET(request: Request) {
      return getGenerationRouteResponse({
        dependencies,
        getGenerationForRoute,
        kieApiKey,
        request,
      });
    },
    POST(request: Request) {
      return postGenerationRouteResponse({
        dependencies,
        kieApiKey,
        postGenerationForRoute,
        request,
      });
    },
  };
}
