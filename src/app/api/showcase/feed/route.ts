import { NextRequest } from 'next/server';

import { getShowcaseFeedRouteResponse } from '@/lib/showcase-feed-route-adapter-service';

export async function GET(request: NextRequest) {
  return getShowcaseFeedRouteResponse({ request });
}
