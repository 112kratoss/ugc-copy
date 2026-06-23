import { NextRequest } from 'next/server';

import { postWorkflowAssistantProposalDiscardRouteResponse } from '@/lib/workflow-assistant-proposal-discard-route-adapter-service';

type RouteParams = { params: Promise<{ id: string; proposalId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  return postWorkflowAssistantProposalDiscardRouteResponse({ request, context: { params } });
}
