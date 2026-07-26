import { NextRequest } from 'next/server';

import { postRetiredPostResourceFileUploadRouteResponse } from '@/lib/post-resource-file-upload-route-adapter-service';

export async function POST(request: NextRequest) {
  return postRetiredPostResourceFileUploadRouteResponse(request);
}
