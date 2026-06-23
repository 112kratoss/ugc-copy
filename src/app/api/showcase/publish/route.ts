import { NextRequest } from 'next/server';

import { postShowcasePublishRouteResponse } from '@/lib/showcase-publish-route-adapter-service';

export async function POST(request: NextRequest) {
  return postShowcasePublishRouteResponse({ request });
}
