import {
  getOnboardingStateRouteResponse,
  patchOnboardingStateRouteResponse,
} from '@/lib/onboarding-route-adapter-service';

export async function GET(request: Request) {
  return getOnboardingStateRouteResponse({ request });
}

export async function PATCH(request: Request) {
  return patchOnboardingStateRouteResponse({ request });
}
