import { NextRequest } from 'next/server';

import { getMarketplaceSalesExportRouteResponse } from '@/lib/marketplace-sales-export-route-adapter-service';

export async function GET(request: NextRequest) {
  return getMarketplaceSalesExportRouteResponse({ request });
}
