import 'server-only';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders, getApiRequestId } from '@/lib/api-cache';
import { withProviderFetchRequestId } from '@/lib/provider-fetch';
import {
  authenticateRequest,
  createServiceClient,
  requireKieApiKey,
} from '@/lib/server-helpers';
import {
  createSeedanceAssetForRoute,
  getSeedanceAssetForRoute,
  type SeedanceAssetRouteResult,
} from '@/lib/seedance-asset-service';

type SeedanceAssetRouteDependencies = {
  authenticateRequest?: typeof authenticateRequest;
  createSeedanceAssetForRoute?: typeof createSeedanceAssetForRoute;
  createServiceClient?: typeof createServiceClient;
  getSeedanceAssetForRoute?: typeof getSeedanceAssetForRoute;
  requireKieApiKey?: typeof requireKieApiKey;
};

function resolveDependencies(dependencies: SeedanceAssetRouteDependencies | undefined) {
  return {
    authenticateRequest: dependencies?.authenticateRequest ?? authenticateRequest,
    createSeedanceAssetForRoute: dependencies?.createSeedanceAssetForRoute ?? createSeedanceAssetForRoute,
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    getSeedanceAssetForRoute: dependencies?.getSeedanceAssetForRoute ?? getSeedanceAssetForRoute,
    requireKieApiKey: dependencies?.requireKieApiKey ?? requireKieApiKey,
  };
}

function toJsonResponse(result: SeedanceAssetRouteResult) {
  if (!result.ok) {
    return NextResponse.json(result.body, {
      status: result.status,
      headers: result.headers,
    });
  }

  return NextResponse.json(result.body);
}

async function authenticateSeedanceAssetRequest(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const authResult = await dependencies.authenticateRequest(request);
  if (authResult instanceof Response) {
    return { ok: false as const, response: authResult };
  }

  const apiKey = dependencies.requireKieApiKey();
  if (apiKey instanceof Response) {
    return { ok: false as const, response: apiKey };
  }

  return {
    ok: true as const,
    apiKey,
    userId: authResult.userId,
  };
}

async function handleSeedanceAssetPOST(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const auth = await authenticateSeedanceAssetRequest(request, dependencies);
  if (!auth.ok) {
    return auth.response;
  }

  try {
    const body = await request.json();
    return toJsonResponse(await dependencies.createSeedanceAssetForRoute({
      adminSupabase: dependencies.createServiceClient(),
      apiKey: auth.apiKey,
      body,
      userId: auth.userId,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create Seedance asset';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function handleSeedanceAssetGET(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const auth = await authenticateSeedanceAssetRequest(request, dependencies);
  if (!auth.ok) {
    return auth.response;
  }

  const assetId = new URL(request.url).searchParams.get('assetId')?.trim() || '';
  return toJsonResponse(await dependencies.getSeedanceAssetForRoute({
    apiKey: auth.apiKey,
    assetId,
  }));
}

export async function postSeedanceAssetRouteResponse({
  request,
  dependencies,
}: {
  request: Request;
  dependencies?: SeedanceAssetRouteDependencies;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);
  return withProviderFetchRequestId(getApiRequestId(request), async () => (
    applyPrivateNoStoreApiResponseHeaders(
      await handleSeedanceAssetPOST(request, resolvedDependencies),
      request,
    )
  ));
}

export async function getSeedanceAssetRouteResponse({
  request,
  dependencies,
}: {
  request: Request;
  dependencies?: SeedanceAssetRouteDependencies;
}) {
  const resolvedDependencies = resolveDependencies(dependencies);
  return withProviderFetchRequestId(
    getApiRequestId(request),
    async () => (
      applyPrivateNoStoreApiResponseHeaders(
        await handleSeedanceAssetGET(request, resolvedDependencies),
        request,
      )
    ),
  );
}

export function createSeedanceAssetRouteHandlers({
  dependencies,
}: {
  dependencies?: SeedanceAssetRouteDependencies;
} = {}) {
  return {
    GET(request: Request) {
      return getSeedanceAssetRouteResponse({ dependencies, request });
    },
    POST(request: Request) {
      return postSeedanceAssetRouteResponse({ dependencies, request });
    },
  };
}
