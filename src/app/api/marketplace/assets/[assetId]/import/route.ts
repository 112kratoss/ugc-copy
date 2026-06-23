import { NextRequest } from 'next/server';

import { postMarketplaceAssetImportRouteResponse } from '@/lib/marketplace-asset-import-route-adapter-service';

interface RouteParams {
  params: Promise<{ assetId: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  return postMarketplaceAssetImportRouteResponse({ request, context: { params } });
}
