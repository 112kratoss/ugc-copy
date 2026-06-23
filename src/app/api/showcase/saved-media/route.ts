import { NextRequest } from 'next/server';

import { getShowcaseSavedMediaRouteResponse } from '@/lib/showcase-saved-media-route-adapter-service';

export async function GET(request: NextRequest) {
    return getShowcaseSavedMediaRouteResponse({ request });
}
