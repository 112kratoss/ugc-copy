import { createKieWebhookRouteHandlers } from '@/lib/kie-webhook-route-adapter-service';

export const runtime = 'nodejs';
export const maxDuration = 60;

export const { POST } = createKieWebhookRouteHandlers();
