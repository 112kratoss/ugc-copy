import { NextRequest } from 'next/server';

import { postGenerationModelQuoteRouteResponse } from '@/lib/generation-model-quote-route-adapter-service';

export async function POST(request: NextRequest) {
  return postGenerationModelQuoteRouteResponse({ request });
}
