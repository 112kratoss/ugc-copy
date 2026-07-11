import { postShowcaseFeedEventRouteResponse } from '@/lib/showcase-feed-events-route-adapter-service';

export async function POST(request: Request) {
  return postShowcaseFeedEventRouteResponse({ request });
}
