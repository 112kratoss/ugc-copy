import { NextRequest } from 'next/server';

import { getShowcaseFeedRouteResponse } from '@/lib/showcase-feed-route-adapter-service';
import { withRegionalIdentityAdmission } from '@/lib/regional-identity-admission';

export async function GET(request: NextRequest) {
  return withRegionalIdentityAdmission(request, (admitted) =>
    getShowcaseFeedRouteResponse({ request: admitted }));
}

// An explicit HEAD keeps the same admission boundary as GET.
export const HEAD = GET;
