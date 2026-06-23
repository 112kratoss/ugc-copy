import { NextRequest } from 'next/server';

import { postShowcaseSaveRouteResponse } from '@/lib/showcase-save-route-adapter-service';

export async function POST(request: NextRequest) {
  return postShowcaseSaveRouteResponse({ request });
}
