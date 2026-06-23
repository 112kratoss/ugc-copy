import { NextRequest } from 'next/server';

import { postMobilePushUnregisterRouteResponse } from '@/lib/mobile-push-route-adapter-service';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  return postMobilePushUnregisterRouteResponse({ request });
}
