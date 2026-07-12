import type { NextRequest } from 'next/server';

import { postWorkflowRunApprovalRouteResponse } from '@/lib/workflow-run-route-adapter-service';

interface RouteParams {
  params: Promise<{ id: string; runId: string; stepId: string }>;
}

export async function POST(request: NextRequest, context: RouteParams) {
  return postWorkflowRunApprovalRouteResponse({ request, context });
}
