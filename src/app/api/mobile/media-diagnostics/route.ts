import { postMobileMediaDiagnosticsRouteResponse } from '@/lib/mobile-media-diagnostics-route-adapter-service';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  return postMobileMediaDiagnosticsRouteResponse({ request });
}
