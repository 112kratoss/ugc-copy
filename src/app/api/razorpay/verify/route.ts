import { postRazorpayCreditVerifyRouteResponse } from '@/lib/razorpay-credit-verify-route-adapter-service';

export async function POST(req: Request) {
  return postRazorpayCreditVerifyRouteResponse({ request: req });
}
