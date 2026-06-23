import { NextRequest } from 'next/server';

import { getRemixSourceRouteResponse } from '@/lib/remix-source-route-adapter-service';

export async function GET(request: NextRequest) {
  return getRemixSourceRouteResponse({ request });
}
