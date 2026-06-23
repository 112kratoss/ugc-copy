import { NextRequest } from 'next/server';

import { postMobileCommerceSyncRouteResponse } from '@/lib/mobile-commerce-sync-route-adapter-service';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  return postMobileCommerceSyncRouteResponse({ request });
}
