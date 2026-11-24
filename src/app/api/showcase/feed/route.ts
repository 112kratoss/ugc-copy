import { NextRequest } from 'next/server';

import * as feed from '@/lib/showcase-feed-route-adapter-service';
import { withRouteOwnedIdentityAdmission } from '@/lib/route-owned-identity-admission';

export async function GET(request: NextRequest) { // A signed-in read is counted beside the lifecycle round trip.
  const receivedAt = performance.now(); // Before admission: the sampled phase log's admission time.
  return withRouteOwnedIdentityAdmission<feed.StartedShowcaseFeedReadLimit>(request, (admitted, startedReadLimit) => (
    feed.getShowcaseFeedRouteResponse({ request: admitted, startedReadLimit, receivedAt })
  ), {}, ({ userId }) => feed.startShowcaseFeedReadLimit(request, userId));
}
export const HEAD = GET; // An explicit HEAD keeps the same admission boundary as GET.
