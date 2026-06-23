import { NextRequest } from 'next/server';

import { getOwnerGenerationsRouteResponse } from '@/lib/owner-generations-route-adapter-service';

export async function GET(request: NextRequest) {
  return getOwnerGenerationsRouteResponse({ request });
}
