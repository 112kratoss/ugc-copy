import { NextRequest } from 'next/server';

import { postProfileShareRouteResponse } from '@/lib/profile-share-route-adapter-service';

export async function POST(request: NextRequest) {
  return postProfileShareRouteResponse({ request });
}
