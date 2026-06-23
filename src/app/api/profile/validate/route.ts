import { NextRequest } from 'next/server';

import { postProfileValidateRouteResponse } from '@/lib/profile-validate-route-adapter-service';

export async function POST(request: NextRequest) {
  return postProfileValidateRouteResponse({ request });
}
