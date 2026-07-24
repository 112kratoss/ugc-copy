import { NextRequest } from 'next/server';

import { postGenerationRouteResponse } from '@/lib/generation-route-adapter-service';
import { getOwnerGenerationsRouteResponse } from '@/lib/owner-generations-route-adapter-service';
import { postUnifiedGenerationForRoute } from '@/lib/unified-generation-route-service';

export async function GET(request: NextRequest) {
  return getOwnerGenerationsRouteResponse({ request });
}
export async function POST(request: NextRequest) {
  return postGenerationRouteResponse({ request, postGenerationForRoute: postUnifiedGenerationForRoute, kieApiKey: process.env.KIE_AI_API_KEY });
}
