import { NextRequest } from 'next/server';

import { getPostMediaRouteResponse } from '@/lib/post-media-route-adapter-service';
import { getMediaRouteResponse } from '@/lib/media-route-adapter-service';

export async function GET(request: NextRequest) {
  if (request.nextUrl.searchParams.get('bucket') === 'post_media') return getPostMediaRouteResponse(request);
  return getMediaRouteResponse({ request });
}
