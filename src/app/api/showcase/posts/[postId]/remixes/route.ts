import { NextRequest } from 'next/server';

import { getPostRemixesRouteResponse, type PostRemixesRouteContext } from '@/lib/post-remixes-route-adapter-service';

export async function GET(request: NextRequest, context: PostRemixesRouteContext) {
  return getPostRemixesRouteResponse({ request, context });
}
