import { NextRequest } from 'next/server';

import { getMarketplaceResourceListRouteResponse } from '@/lib/marketplace-resource-list-route-adapter-service';

export async function GET(request: NextRequest) {
  return getMarketplaceResourceListRouteResponse({ request });
}
