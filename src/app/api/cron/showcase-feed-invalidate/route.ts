import { createShowcaseFeedInvalidateRouteHandlers } from '@/lib/showcase-feed-invalidate-route-adapter-service';

export const runtime = 'nodejs';
export const maxDuration = 10;

export const { GET } = createShowcaseFeedInvalidateRouteHandlers();
