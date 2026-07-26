import { postCspReportRouteResponse } from '@/lib/csp-report-route-adapter-service';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  return postCspReportRouteResponse({ request });
}
