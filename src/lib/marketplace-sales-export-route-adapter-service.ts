import 'server-only';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import {
  exportMarketplaceSalesForRoute,
  type MarketplaceSalesExportRouteResult,
} from '@/lib/marketplace-sales-export-service';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

const SALES_EXPORT_HEADERS = {
  'Content-Type': 'text/csv; charset=utf-8',
  'Content-Disposition': 'attachment; filename="marketplace-sales.csv"',
} as const;

type MarketplaceSalesExportRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  createUserClient?: typeof createUserClient;
  exportMarketplaceSalesForRoute?: typeof exportMarketplaceSalesForRoute;
};

function resolveDependencies(dependencies: MarketplaceSalesExportRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    createUserClient: dependencies?.createUserClient ?? createUserClient,
    exportMarketplaceSalesForRoute:
      dependencies?.exportMarketplaceSalesForRoute ?? exportMarketplaceSalesForRoute,
  };
}

function toResponse(result: MarketplaceSalesExportRouteResult) {
  if (!result.ok) {
    return new Response(result.body, { status: result.status });
  }

  return new Response(result.csv, {
    status: 200,
    headers: SALES_EXPORT_HEADERS,
  });
}

async function handleMarketplaceSalesExportGET(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const supabase = dependencies.createUserClient(request);
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return new Response('Unauthorized', { status: 401 });
  }

  return toResponse(await dependencies.exportMarketplaceSalesForRoute({
    adminSupabase: dependencies.createServiceClient(),
    sellerUserId: user.id,
  }));
}

export async function getMarketplaceSalesExportRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: MarketplaceSalesExportRouteDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handleMarketplaceSalesExportGET(request, resolveDependencies(dependencies)),
    request,
  );
}
