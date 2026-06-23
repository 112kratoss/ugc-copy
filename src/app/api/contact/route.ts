import { postContactRouteResponse } from '@/lib/contact-route-adapter-service';

export async function POST(req: Request) {
  return postContactRouteResponse({ request: req });
}
