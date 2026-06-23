import { NextRequest } from 'next/server';

import { postPostResourceBundleVerifyRouteResponse } from '@/lib/post-resource-bundle-verify-route-adapter-service';

export async function POST(request: NextRequest) {
  return postPostResourceBundleVerifyRouteResponse({ request });
}
