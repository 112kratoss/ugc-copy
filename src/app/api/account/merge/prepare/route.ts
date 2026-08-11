import { NextRequest } from 'next/server';

import { postAccountMergePrepareRouteResponse } from '@/lib/account-merge-route-adapter-service';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  return postAccountMergePrepareRouteResponse({ request });
}
