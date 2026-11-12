import { getSearchSuggestRouteResponse } from '@/lib/search-suggest-route-adapter-service';

export async function GET(request: Request) {
  return getSearchSuggestRouteResponse({ request });
}
