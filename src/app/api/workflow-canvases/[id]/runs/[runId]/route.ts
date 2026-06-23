import { NextRequest } from 'next/server';

import { getWorkflowRunDetailsRouteResponse } from '@/lib/workflow-run-route-adapter-service';

interface RouteParams {
  params: Promise<{ id: string; runId: string }>;
}

export async function GET(request: NextRequest, context: RouteParams) {
  return getWorkflowRunDetailsRouteResponse({ request, context });
}
