import type { NextRequest } from 'next/server';

import { postMarketplaceVerifyRouteResponse } from '@/lib/marketplace-verify-route-adapter-service';

export async function POST(request: NextRequest) {
  return postMarketplaceVerifyRouteResponse({ request });
}
