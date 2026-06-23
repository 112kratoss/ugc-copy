import type { NextRequest } from 'next/server';

import { postOwnerPostRestoreRouteResponse } from '@/lib/post-lifecycle-route-adapter-service';

type RouteContext = {
  params: Promise<{ postId: string }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  const { postId } = await context.params;
  return postOwnerPostRestoreRouteResponse({ request, postId });
}
