import { NextRequest } from 'next/server';

import { postShowcaseSaveRouteResponse } from '@/lib/showcase-save-route-adapter-service';

// The push about a named save waits 30 s behind the answer
// (`NAMED_SAVE_PUSH_HOLD_MS`, in `after()`): room for it and the send.
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  return postShowcaseSaveRouteResponse({ request });
}
