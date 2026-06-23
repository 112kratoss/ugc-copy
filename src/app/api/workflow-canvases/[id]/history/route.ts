import { NextRequest } from 'next/server';

import { getWorkflowCanvasHistoryRouteResponse } from '@/lib/workflow-canvas-lifecycle-route-adapter-service';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  return getWorkflowCanvasHistoryRouteResponse({ request, canvasId: id });
}
