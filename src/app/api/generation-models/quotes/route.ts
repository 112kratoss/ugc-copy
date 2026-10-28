import { NextRequest } from 'next/server';

import { postGenerationModelQuoteBatchRouteResponse } from '@/lib/generation-model-quote-batch-route-adapter-service';

export async function POST(request: NextRequest) {
  return postGenerationModelQuoteBatchRouteResponse({ request });
}
