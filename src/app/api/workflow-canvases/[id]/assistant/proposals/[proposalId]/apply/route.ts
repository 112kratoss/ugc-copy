import { NextRequest } from 'next/server';

import { postWorkflowAssistantProposalApplyRouteResponse } from '@/lib/workflow-assistant-proposal-apply-route-adapter-service';

interface RouteParams {
  params: Promise<{ id: string; proposalId: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  return postWorkflowAssistantProposalApplyRouteResponse({ request, context: { params } });
}
