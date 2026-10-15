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
import { withReferralClaimStatus } from '@/lib/referral';
import { clearReferralVisitCookie } from '@/lib/referral-route-service';

import { claimPendingReferralForAuth, recordWebAuthSucceeded } from '../post-auth';

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const next = getSafeAuthNextPath(requestUrl.searchParams.get('next'));

  try {
    const supabase = await createAuthRouteClient();
    const { data, error } = await supabase.auth.getUser();

    if (!error && data.user) {
      const referral = await claimPendingReferralForAuth(request, data.user.id);
      const destination = await resolveServerPostAuthPath(
        supabase,
        data.user.id,
        next,
        { skipProfileOnboarding: hasSkippedProfileOnboarding(data.user.user_metadata) }
      );
      const response = NextResponse.redirect(
        new URL(withReferralClaimStatus(destination, referral.status), requestUrl.origin)
      );
      if (referral.clearCookie) {
        clearReferralVisitCookie(response, requestUrl.protocol === 'https:');
      }
      await recordWebAuthSucceeded({ next, origin: requestUrl.origin, supabase, userId: data.user.id });
      return response;
    }
  } catch {
    // Fall through to the recoverable error screen with the safe intent intact.
  }

  // A password sign-in failed here, not a link: the error page says so (audit 01-9).
  return NextResponse.redirect(
    new URL(`${buildAuthCodeErrorPath(next)}&method=password`, requestUrl.origin)
  );
}
