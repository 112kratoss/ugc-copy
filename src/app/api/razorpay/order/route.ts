import { postRazorpayCreditOrderRouteResponse } from '@/lib/razorpay-credit-order-route-adapter-service';

export async function POST(req: Request) {
  return postRazorpayCreditOrderRouteResponse({ request: req });
}
