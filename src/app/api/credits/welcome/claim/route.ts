import { postWelcomeCreditsClaimRouteResponse } from '@/lib/onboarding-route-adapter-service';

export async function POST(request: Request) {
  return postWelcomeCreditsClaimRouteResponse({ request });
}
