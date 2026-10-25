import { getHomeShelfRouteResponse } from '@/lib/home-shelf-route-adapter-service';

export async function GET(request: Request) {
  return getHomeShelfRouteResponse({ request });
}
