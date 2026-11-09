import { NextRequest } from 'next/server';

import { getShowcaseFeedRouteResponse } from '@/lib/showcase-feed-route-adapter-service';
import { withRouteOwnedIdentityAdmission } from '@/lib/route-owned-identity-admission';

export async function GET(request: NextRequest) {
  return withRouteOwnedIdentityAdmission(request, (admitted) =>
    getShowcaseFeedRouteResponse({ request: admitted }));
}

// An explicit HEAD keeps the same admission boundary as GET.
export const HEAD = GET;
