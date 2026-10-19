import { NextRequest } from 'next/server';

import { postSaverNoticeRouteResponse } from '@/lib/saver-notice-route-adapter-service';

export async function POST(request: NextRequest) {
  return postSaverNoticeRouteResponse({ request });
}
