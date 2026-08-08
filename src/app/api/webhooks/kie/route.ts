import { createKieWebhookRouteHandlers } from '@/lib/kie-webhook-route-adapter-service';

export const runtime = 'nodejs';
// The finished-video import -- download from the provider, then re-upload to
// Storage -- runs after the response inside this same invocation. The download
// alone is allowed PROVIDER_MEDIA_DOWNLOAD_TIMEOUT_MS (60s), so a 60s ceiling
// left no time at all for the upload and every large video fell through to the
// 10-minute completion cron. 300s matches every other media-touching route.
export const maxDuration = 300;

export const { POST } = createKieWebhookRouteHandlers();
