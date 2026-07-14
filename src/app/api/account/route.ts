import { NextRequest } from 'next/server';

import { deleteAccountRouteResponse } from '@/lib/account-deletion-route-adapter-service';

export const runtime = 'nodejs';

export async function DELETE(request: NextRequest) {
  return deleteAccountRouteResponse({ request });
}
