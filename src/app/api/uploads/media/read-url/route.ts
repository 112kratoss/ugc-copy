import { NextRequest } from 'next/server';

import { postTemporaryMediaReadUrlRouteResponse } from '@/lib/temporary-media-read-url-route-adapter-service';

export async function POST(request: NextRequest) {
  return postTemporaryMediaReadUrlRouteResponse({ request });
}
