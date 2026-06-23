import { NextRequest } from 'next/server';

import { getSourceToolsRouteResponse } from '@/lib/source-tools-route-adapter-service';

export async function GET(request?: NextRequest) {
  return getSourceToolsRouteResponse({ request });
}
