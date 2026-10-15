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
  const code = requestUrl.searchParams.get('code');
  const next = getSafeAuthNextPath(requestUrl.searchParams.get('next'));

  if (code) {
    try {
      const supabase = await createAuthRouteClient();
      const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);

      if (!exchangeError) {
        const { data, error: userError } = await supabase.auth.getUser();

        if (!userError && data.user) {
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
          // Google and the email links finish here, never in /auth/continue.
          await recordWebAuthSucceeded({ next, origin: requestUrl.origin, supabase, userId: data.user.id });
          return response;
        }
      }
    } catch {
      // Fall through to the recoverable error screen with the safe intent intact.
    }
  }

  return NextResponse.redirect(
    new URL(buildAuthCodeErrorPath(next), requestUrl.origin)
  );
}
