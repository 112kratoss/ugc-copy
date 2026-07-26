import { NextRequest } from 'next/server';

import { postPostResourceFileDirectUploadRouteResponse } from '@/lib/post-resource-file-direct-upload-route-adapter-service';

export async function POST(request: NextRequest) {
  return postPostResourceFileDirectUploadRouteResponse({ action: 'sign', request });
}
