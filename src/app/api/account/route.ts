import { NextRequest } from 'next/server';

import { deleteAccountRouteResponse } from '@/lib/account-deletion-route-adapter-service';

export const runtime = 'nodejs';
// The answer comes back once deletion is scheduled, but the storage sweep runs
// on in after() within this budget; the scheduler resumes whatever it leaves.
export const maxDuration = 300;

export async function DELETE(request: NextRequest) {
  return deleteAccountRouteResponse({ request });
}
