import type { NextRequest } from 'next/server';

import { generationRestoreRouteResponse } from '@/lib/generation-lifecycle-route-adapter-service';

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  return generationRestoreRouteResponse({ generationId: id, request });
}
