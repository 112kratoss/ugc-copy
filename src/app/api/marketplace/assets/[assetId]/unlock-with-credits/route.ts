import { NextRequest } from 'next/server';

import { postMarketplaceCreditUnlockRouteResponse } from '@/lib/credit-unlock-route-adapter-service';

type RouteContext = {
  params: Promise<{ assetId: string }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  return postMarketplaceCreditUnlockRouteResponse({ context, request });
}
