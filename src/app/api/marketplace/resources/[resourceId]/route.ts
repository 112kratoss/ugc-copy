import { NextRequest } from 'next/server';

import { getMarketplaceResourceDetailRouteResponse } from '@/lib/marketplace-resource-detail-route-adapter-service';

type RouteContext = {
  params: Promise<{ resourceId: string }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  return getMarketplaceResourceDetailRouteResponse({ context, request });
}
