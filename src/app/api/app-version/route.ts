import { getAppVersionRouteResponse } from '@/lib/app-version-route-adapter-service';

export async function GET(request: Request) {
  return getAppVersionRouteResponse({ request });
}
