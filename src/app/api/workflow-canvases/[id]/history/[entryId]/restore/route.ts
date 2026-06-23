import { NextRequest } from 'next/server';

import { restoreWorkflowCanvasHistoryRouteResponse } from '@/lib/workflow-canvas-lifecycle-route-adapter-service';

interface RouteParams {
  params: Promise<{ id: string; entryId: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id, entryId } = await params;
  return restoreWorkflowCanvasHistoryRouteResponse({ request, canvasId: id, entryId });
}
