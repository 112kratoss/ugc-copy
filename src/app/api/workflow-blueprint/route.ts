import { NextRequest } from 'next/server';

import { postWorkflowBlueprintRouteResponse } from '@/lib/workflow-blueprint-route-adapter-service';

export async function POST(request: NextRequest) {
  return postWorkflowBlueprintRouteResponse({ request });
}
