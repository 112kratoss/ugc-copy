import { NextRequest } from 'next/server';

import { postAccountMergeRouteResponse } from '@/lib/account-merge-route-adapter-service';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  return postAccountMergeRouteResponse({ request });
}
