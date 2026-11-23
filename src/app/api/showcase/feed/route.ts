import { NextRequest } from 'next/server';

import * as feed from '@/lib/showcase-feed-route-adapter-service';
import { withRouteOwnedIdentityAdmission } from '@/lib/route-owned-identity-admission';

export async function GET(request: NextRequest) { // A signed-in read is counted beside the lifecycle round trip.
  return withRouteOwnedIdentityAdmission<feed.StartedShowcaseFeedReadLimit>(request, (admitted, startedReadLimit) => (
    feed.getShowcaseFeedRouteResponse({ request: admitted, startedReadLimit })
  ), {}, ({ userId }) => feed.startShowcaseFeedReadLimit(request, userId));
}

export const HEAD = GET; // An explicit HEAD keeps the same admission boundary as GET.
