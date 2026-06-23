import { NextRequest } from 'next/server';

import { postProfileMediaSignRouteResponse } from '@/lib/profile-media-route-adapter-service';

export async function POST(request: NextRequest) {
  return postProfileMediaSignRouteResponse({ request });
}
