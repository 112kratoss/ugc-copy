import type { NextRequest } from 'next/server';

import { postModerationReportRouteResponse } from '@/lib/moderation-route-adapter-service';

export function POST(request: NextRequest) {
  return postModerationReportRouteResponse({ request });
}
