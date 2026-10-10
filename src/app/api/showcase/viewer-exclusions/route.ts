import type { NextRequest } from 'next/server';

import { postShowcaseViewerExclusionsRouteResponse } from '@/lib/showcase-viewer-exclusions-route-adapter-service';

export async function POST(request: NextRequest) {
  return postShowcaseViewerExclusionsRouteResponse({ request });
}
