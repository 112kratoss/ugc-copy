import { NextRequest } from 'next/server';

import { postResourceBundleCreditUnlockRouteResponse } from '@/lib/credit-unlock-route-adapter-service';

type RouteContext = {
  params: Promise<{ postId: string }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  return postResourceBundleCreditUnlockRouteResponse({ context, request });
}
