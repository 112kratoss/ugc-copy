import { NextRequest } from 'next/server';

import { getMobileNotificationListRouteResponse } from '@/lib/mobile-notification-list-route-adapter-service';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  return getMobileNotificationListRouteResponse({ request });
}
