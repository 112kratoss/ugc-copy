import { NextRequest } from 'next/server';

import { postProfileFollowNotifyRouteResponse } from '@/lib/profile-follow-route-adapter-service';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  return postProfileFollowNotifyRouteResponse({ request });
}
