import { NextRequest } from 'next/server';

import { postWorkflowShareCreateRouteResponse } from '@/lib/workflow-share-route-adapter-service';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  return postWorkflowShareCreateRouteResponse({ context: { params }, request });
}
