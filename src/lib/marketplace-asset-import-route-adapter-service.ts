import 'server-only';
import { logBackendRouteError } from '@/lib/backend-logger';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { createBackendRateLimitResponse } from '@/lib/backend-rate-limit';
import {
  importMarketplaceWorkflowAssetForRoute,
  type MarketplaceAssetImportResult,
} from '@/lib/marketplace-asset-import-service';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type MarketplaceAssetImportRouteContext = {
  params: Promise<{ assetId: string }>;
};

type MarketplaceAssetImportRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  importMarketplaceWorkflowAssetForRoute?: typeof importMarketplaceWorkflowAssetForRoute;
  logError?: typeof logBackendRouteError;
};

function resolveDependencies(dependencies: MarketplaceAssetImportRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    importMarketplaceWorkflowAssetForRoute:
      dependencies?.importMarketplaceWorkflowAssetForRoute ?? importMarketplaceWorkflowAssetForRoute,
    logError: dependencies?.logError ?? logBackendRouteError,
  };
}

function createRateLimitResponse(result: MarketplaceAssetImportResult & { ok: false }) {
  return createBackendRateLimitResponse({
    name: 'BackendRateLimitError',
    message: String(result.body.error ?? 'Too many requests. Please wait before trying again.'),
    status: 429,
    retryAfterSeconds: result.retryAfterSeconds ?? 0,
    state: {
      allowed: false,
      limit: result.limit ?? 0,
      remaining: result.remaining ?? 0,
      retryAfterSeconds: result.retryAfterSeconds ?? 0,
      resetAt: result.resetAt ?? new Date().toISOString(),
    },
  });
}

function toJsonResponse(result: MarketplaceAssetImportResult) {
  if (!result.ok) {
    if (result.status === 429 && result.code === 'RATE_LIMITED') {
      return createRateLimitResponse(result);
    }

    return NextResponse.json(result.body, { status: result.status });
  }

  return NextResponse.json(result.body);
}

async function handleMarketplaceAssetImportPOST(
  request: Request,
  context: MarketplaceAssetImportRouteContext,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  try {
    const { assetId } = await context.params;
    const supabase = dependencies.createUserClient(request);
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return toJsonResponse(await dependencies.importMarketplaceWorkflowAssetForRoute({
      adminSupabase: dependencies.createServiceClient(),
      assetId,
      userId: user.id,
      userSupabase: supabase,
    }));
  } catch (error) {
    dependencies.logError('Workflow asset import failed:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function postMarketplaceAssetImportRouteResponse({
  context,
  dependencies,
  request,
}: {
  context: MarketplaceAssetImportRouteContext;
  dependencies?: MarketplaceAssetImportRouteDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handleMarketplaceAssetImportPOST(request, context, resolveDependencies(dependencies)),
    request,
  );
}
