import { NextRequest } from 'next/server';

import { postProfileMediaCleanupRouteResponse } from '@/lib/profile-media-route-adapter-service';

export async function POST(request: NextRequest) {
  return postProfileMediaCleanupRouteResponse({ request });
}
