import { postMobileClientErrorsRouteResponse } from '@/lib/mobile-client-errors-route-adapter-service';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  return postMobileClientErrorsRouteResponse({ request });
}
