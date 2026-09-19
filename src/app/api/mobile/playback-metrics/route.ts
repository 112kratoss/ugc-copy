import { postMobilePlaybackMetricsRouteResponse } from '@/lib/mobile-playback-metrics-route-adapter-service';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  return postMobilePlaybackMetricsRouteResponse({ request });
}
