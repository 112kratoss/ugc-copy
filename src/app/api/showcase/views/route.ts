import { postPostViewsRouteResponse } from '@/lib/post-views-route-adapter-service';

export async function POST(request: Request) {
  return postPostViewsRouteResponse({ request });
}
