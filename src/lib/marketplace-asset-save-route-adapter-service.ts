import 'server-only';
import { logBackendRouteError } from '@/lib/backend-logger';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { createBackendRateLimitResponse } from '@/lib/backend-rate-limit';
import {
  saveMarketplaceAssetForRoute,
  type MarketplaceAssetSaveRouteResult,
} from '@/lib/marketplace-asset-save-service';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type MarketplaceAssetSaveRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  logError?: typeof logBackendRouteError;
  saveMarketplaceAssetForRoute?: typeof saveMarketplaceAssetForRoute;
};

function resolveDependencies(dependencies: MarketplaceAssetSaveRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    logError: dependencies?.logError ?? logBackendRouteError,
    saveMarketplaceAssetForRoute:
      dependencies?.saveMarketplaceAssetForRoute ?? saveMarketplaceAssetForRoute,
  };
}

function toJsonResponse(result: MarketplaceAssetSaveRouteResult) {
  if (!result.ok && result.rateLimitError) {
    return createBackendRateLimitResponse(result.rateLimitError);
  }

  if (!result.ok) {
    return NextResponse.json(result.body, { status: result.status });
  }

  return NextResponse.json(result.body);
}

async function handleMarketplaceAssetSavePOST(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  try {
    const supabase = dependencies.createUserClient(request);
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return toJsonResponse(await dependencies.saveMarketplaceAssetForRoute({
      adminSupabase: dependencies.createServiceClient(),
      readBody: () => request.json(),
      userId: user.id,
      userSupabase: supabase,
    }));
  } catch (error) {
    dependencies.logError('Marketplace asset save failed:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function postMarketplaceAssetSaveRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: MarketplaceAssetSaveRouteDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handleMarketplaceAssetSavePOST(request, resolveDependencies(dependencies)),
    request,
  );
}
