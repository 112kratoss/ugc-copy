import { getWelcomeCreditsRouteResponse } from '@/lib/onboarding-route-adapter-service';

export async function GET(request: Request) {
  return getWelcomeCreditsRouteResponse({ request });
}
