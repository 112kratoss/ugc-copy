import { NextRequest } from 'next/server';

import { getGenerationModelCatalogRouteResponse } from '@/lib/generation-model-catalog-route-adapter-service';

export async function GET(request: NextRequest) {
  return getGenerationModelCatalogRouteResponse({ request });
}
