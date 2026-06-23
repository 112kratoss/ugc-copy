import { NextRequest } from 'next/server';

import { postWorkflowAssetUploadSignRouteResponse } from '@/lib/workflow-asset-upload-sign-route-adapter-service';

export async function POST(request: NextRequest) {
  return postWorkflowAssetUploadSignRouteResponse({ request });
}
