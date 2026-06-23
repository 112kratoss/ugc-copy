import type { NextRequest } from 'next/server';

import { getShowcaseSavedStateRouteResponse } from '@/lib/showcase-saved-state-route-adapter-service';

export async function GET(request: NextRequest) {
  return getShowcaseSavedStateRouteResponse({ request });
}
