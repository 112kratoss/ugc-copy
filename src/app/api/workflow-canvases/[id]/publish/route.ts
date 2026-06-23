import { NextRequest } from 'next/server';

import { publishWorkflowCanvasRouteResponse } from '@/lib/workflow-canvas-lifecycle-route-adapter-service';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  return publishWorkflowCanvasRouteResponse({ request, canvasId: id });
}
