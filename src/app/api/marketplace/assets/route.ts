import type { NextRequest } from 'next/server';

import { postMarketplaceAssetSaveRouteResponse } from '@/lib/marketplace-asset-save-route-adapter-service';

export function POST(request: NextRequest) {
  return postMarketplaceAssetSaveRouteResponse({ request });
}
