import { NextRequest } from 'next/server';

import { postMobileCommerceRestoreRouteResponse } from '@/lib/mobile-commerce-restore-route-adapter-service';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  return postMobileCommerceRestoreRouteResponse({ request });
}
