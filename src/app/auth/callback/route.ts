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
import { logBackendError } from '@/lib/backend-logger';
import { withReferralClaimStatus } from '@/lib/referral';
import { clearReferralVisitCookie } from '@/lib/referral-route-service';

import { claimPendingReferralForAuth, recordWebAuthSucceeded } from '../post-auth';

/** A provider's word for a sign-in the person turned down: Google's, then Apple's Cancel. */
const PROVIDER_CANCELLATIONS = new Set(['access_denied', 'user_cancelled_authorize']);

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get('code');
  const next = getSafeAuthNextPath(requestUrl.searchParams.get('next'));
  const providerError = requestUrl.searchParams.get('error');

  // Supabase sends a provider's refusal back here without a code. A cancel goes
  // back to sign in, keeping where it was going. Anything else is logged, because
  // the page it ends on cannot say why: an expired Apple client secret, for one,
  // fails every web Apple sign-in this way (the runbook's "Sign in with Apple on
  // the web").
  if (!code && providerError) {
    if (PROVIDER_CANCELLATIONS.has(providerError)) {
      return NextResponse.redirect(
        new URL(`/login?returnUrl=${encodeURIComponent(next)}`, requestUrl.origin)
      );
    }
    logBackendError('auth_callback_provider_error', {
      error: providerError,
      errorCode: requestUrl.searchParams.get('error_code'),
      errorDescription: requestUrl.searchParams.get('error_description'),
    });
  }

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
          // Google, Apple and the email links finish here, never in /auth/continue.
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
