import { NextRequest } from 'next/server';

import { postMobileNotificationReadRouteResponse } from '@/lib/mobile-notification-read-route-adapter-service';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  return postMobileNotificationReadRouteResponse({ request });
}
