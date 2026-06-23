import { NextRequest } from 'next/server';

import { getMediaRouteResponse } from '@/lib/media-route-adapter-service';

export async function GET(request: NextRequest) {
    return getMediaRouteResponse({ request });
}
