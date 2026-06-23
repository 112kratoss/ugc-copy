import { postRevenueCatWebhookRouteResponse } from '@/lib/revenuecat-webhook-route-adapter-service';

export async function POST(request: Request) {
  return postRevenueCatWebhookRouteResponse({ request });
}
