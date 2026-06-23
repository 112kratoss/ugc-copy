import type { NextRequest } from 'next/server';

import { postWorkflowRunRouteResponse } from '@/lib/workflow-run-route-adapter-service';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  return postWorkflowRunRouteResponse({ request, canvasId: id });
}
