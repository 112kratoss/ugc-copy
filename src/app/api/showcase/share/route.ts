import { NextRequest } from 'next/server';

import { postShowcaseShareRouteResponse } from '@/lib/showcase-share-route-adapter-service';

export async function POST(request: NextRequest) {
  return postShowcaseShareRouteResponse({ request });
}
