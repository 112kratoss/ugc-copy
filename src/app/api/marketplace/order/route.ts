import { NextRequest } from 'next/server';

import { postMarketplaceOrderRouteResponse } from '@/lib/marketplace-order-route-adapter-service';

export async function POST(request: NextRequest) {
  return postMarketplaceOrderRouteResponse({ request });
}
