import { NextRequest } from 'next/server';

import { postShowcaseRemixRouteResponse } from '@/lib/showcase-remix-route-adapter-service';

export async function POST(request: NextRequest) {
  return postShowcaseRemixRouteResponse({ request });
}
