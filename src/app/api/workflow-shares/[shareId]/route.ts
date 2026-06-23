import { NextRequest } from 'next/server';

import { getWorkflowSharePreviewRouteResponse } from '@/lib/workflow-share-route-adapter-service';

interface RouteParams {
  params: Promise<{ shareId: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  return getWorkflowSharePreviewRouteResponse({ context: { params }, request });
}
