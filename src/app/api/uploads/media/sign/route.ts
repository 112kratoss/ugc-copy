import { NextRequest } from 'next/server';

import { postTemporaryMediaUploadSignRouteResponse } from '@/lib/temporary-media-upload-sign-route-adapter-service';

export async function POST(request: NextRequest) {
  return postTemporaryMediaUploadSignRouteResponse({ request });
}
