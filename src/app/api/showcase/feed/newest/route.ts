import { getShowcaseFeedNewestRouteResponse } from '@/lib/showcase-feed-newest-route-adapter-service';

export async function GET(request: Request) {
  return getShowcaseFeedNewestRouteResponse({ request });
}
