import { NextRequest } from 'next/server';

import { postMobileNotificationReadAllRouteResponse } from '@/lib/mobile-notification-read-route-adapter-service';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  return postMobileNotificationReadAllRouteResponse({ request });
}
