import { NextRequest } from 'next/server';

import { postPostResourceBundleOrderRouteResponse } from '@/lib/post-resource-bundle-order-route-adapter-service';

type RouteContext = {
  params: Promise<{ postId: string }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  return postPostResourceBundleOrderRouteResponse({ context, request });
}
