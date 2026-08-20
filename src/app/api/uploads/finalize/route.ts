import { postUploadFinalizeRouteResponse } from '@/lib/upload-finalize-route-adapter-service';

export async function POST(request: Request) {
  return postUploadFinalizeRouteResponse({ request });
}
