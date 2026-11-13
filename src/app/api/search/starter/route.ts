import { getSearchStarterRouteResponse } from '@/lib/search-starter-route-adapter-service';

export async function GET(request: Request) {
  return getSearchStarterRouteResponse({ request });
}
