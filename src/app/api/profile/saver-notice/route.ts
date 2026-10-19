import { NextRequest } from 'next/server';

import { getSaverNoticeRouteResponse, postSaverNoticeRouteResponse } from '@/lib/saver-notice-route-adapter-service';

export async function GET(request: NextRequest) {
  return getSaverNoticeRouteResponse({ request });
}

export async function POST(request: NextRequest) {
  return postSaverNoticeRouteResponse({ request });
}
