import { NextResponse } from 'next/server';

import {
  buildAuthCodeErrorPath,
  getSafeAuthNextPath,
  hasSkippedProfileOnboarding,
} from '@/lib/auth-onboarding';
import {
  createAuthRouteClient,
  resolveServerPostAuthPath,
} from '@/lib/auth-onboarding-server';

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const next = getSafeAuthNextPath(requestUrl.searchParams.get('next'));

  try {
    const supabase = await createAuthRouteClient();
    const { data, error } = await supabase.auth.getUser();

    if (!error && data.user) {
      const destination = await resolveServerPostAuthPath(
        supabase,
        data.user.id,
        next,
        { skipProfileOnboarding: hasSkippedProfileOnboarding(data.user.user_metadata) }
      );
      return NextResponse.redirect(new URL(destination, requestUrl.origin));
    }
  } catch {
    // Fall through to the recoverable error screen with the safe intent intact.
  }

  return NextResponse.redirect(
    new URL(buildAuthCodeErrorPath(next), requestUrl.origin)
  );
}
