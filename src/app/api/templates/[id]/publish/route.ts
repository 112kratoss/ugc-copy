import { createMediaTemplatePublishRouteHandlers } from '@/lib/media-template-route-adapter-service';

export const runtime = 'nodejs';
// Publishing copies fixed assets and the demo between storage buckets and
// derives the demo poster frame with ffmpeg, so it needs the same inline
// media budget as the legacy posts path.
export const maxDuration = 300;

export const { POST } = createMediaTemplatePublishRouteHandlers();
