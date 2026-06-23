import { NextRequest } from 'next/server';

import { generationDeleteRouteResponse } from '@/lib/generation-lifecycle-route-adapter-service';

type RouteContext = { params: Promise<{ id: string }> };

export async function DELETE(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  return generationDeleteRouteResponse({ request, generationId: id });
}
