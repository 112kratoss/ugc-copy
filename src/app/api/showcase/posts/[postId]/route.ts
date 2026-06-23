import { NextRequest } from 'next/server';

import { getShowcasePostDetailRouteResponse } from '@/lib/showcase-post-detail-route-adapter-service';

type RouteContext = {
  params: Promise<{ postId: string }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  return getShowcasePostDetailRouteResponse({ request, context });
}
