import { getPublicSearchRouteResponse } from '@/lib/public-search-route-adapter-service';

export async function GET(request: Request) {
  return getPublicSearchRouteResponse({ request });
}
