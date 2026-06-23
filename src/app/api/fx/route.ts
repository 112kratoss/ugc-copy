import { getFxRouteResponse } from '@/lib/fx-route-adapter-service';

export async function GET(request: Request) {
  return getFxRouteResponse({ request });
}
