import { NextRequest } from 'next/server';

import { postPostResourceFileUrlRouteResponse } from '@/lib/post-resource-file-url-route-adapter-service';

type RouteContext = {
  params: Promise<{ postId: string }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  return postPostResourceFileUrlRouteResponse({ context, request });
}
