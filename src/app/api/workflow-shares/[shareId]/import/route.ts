import { NextRequest } from 'next/server';

import { postWorkflowShareImportRouteResponse } from '@/lib/workflow-share-route-adapter-service';

interface RouteParams {
  params: Promise<{ shareId: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  return postWorkflowShareImportRouteResponse({ context: { params }, request });
}
