import type { NextRequest } from 'next/server';

import { postResourceBundleFreeUnlockRouteResponse } from '@/lib/post-resource-bundle-free-unlock-route-adapter-service';

type RouteContext = {
  params: Promise<{ postId: string }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  const { postId } = await context.params;
  return postResourceBundleFreeUnlockRouteResponse({ postId, request });
}
