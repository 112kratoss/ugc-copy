import { NextRequest } from 'next/server';

import { postMobilePushRegisterRouteResponse } from '@/lib/mobile-push-route-adapter-service';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  return postMobilePushRegisterRouteResponse({ request });
}
