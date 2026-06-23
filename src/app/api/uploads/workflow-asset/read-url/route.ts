import { NextRequest } from 'next/server';

import { postWorkflowAssetReadUrlRouteResponse } from '@/lib/workflow-asset-read-url-route-adapter-service';

export async function POST(request: NextRequest) {
  return postWorkflowAssetReadUrlRouteResponse({ request });
}
