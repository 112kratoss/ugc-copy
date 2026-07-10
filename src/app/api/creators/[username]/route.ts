import { NextRequest } from 'next/server';

import { getCreatorProfileRouteResponse } from '@/lib/creator-profile-route-adapter-service';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ username: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  return getCreatorProfileRouteResponse({ request, context });
}
