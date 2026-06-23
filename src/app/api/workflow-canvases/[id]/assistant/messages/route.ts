import { NextRequest } from 'next/server';

import { postWorkflowAssistantMessageRouteResponse } from '@/lib/workflow-assistant-message-route-adapter-service';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  return postWorkflowAssistantMessageRouteResponse({ context: { params }, request });
}
