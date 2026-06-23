import type { NextRequest } from 'next/server';

import { postReportRouteResponse } from '@/lib/post-report-route-adapter-service';

type RouteContext = {
  params: Promise<{ postId: string }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  const { postId } = await context.params;
  return postReportRouteResponse({ postId, request });
}
