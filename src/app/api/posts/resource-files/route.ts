import { NextRequest } from 'next/server';

import { postPostResourceFileUploadRouteResponse } from '@/lib/post-resource-file-upload-route-adapter-service';

export async function POST(request: NextRequest) {
  return postPostResourceFileUploadRouteResponse({ request });
}
