import { postSearchOpenedRouteResponse } from '@/lib/search-opened-route-adapter-service';

export async function POST(request: Request) {
  return postSearchOpenedRouteResponse({ request });
}
