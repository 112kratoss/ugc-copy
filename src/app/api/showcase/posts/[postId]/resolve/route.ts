import { NextRequest } from 'next/server';

import { getShowcasePostResolveRouteResponse } from '@/lib/showcase-post-resolve-route-adapter-service';

type RouteContext = {
  params: Promise<{ postId: string }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  return getShowcasePostResolveRouteResponse({ request, context });
}
