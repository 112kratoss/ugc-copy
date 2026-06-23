import { postRazorpayWebhookRouteResponse } from '@/lib/razorpay-webhook-route-adapter-service';

export async function POST(req: Request) {
  return postRazorpayWebhookRouteResponse({ request: req });
}
