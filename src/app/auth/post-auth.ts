import 'server-only';

import { createHash, randomUUID } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';
import { after } from 'next/server';

import { logBackendError } from '@/lib/backend-logger';
import { postOnboardingEventRouteResponse } from '@/lib/onboarding-route-adapter-service';
import { readReferralVisitCookie, referralClaimStatus } from '@/lib/referral';
import { claimReferralForUser } from '@/lib/referral-route-service';
import { createServiceClient } from '@/lib/server-helpers';

// What /auth/continue and /auth/callback share after a sign-in has been
// verified. Both finish a sign-in (a password on the first, a provider or an
// email link on the second), so both claim a saved invite and both count it.

export type PendingReferralClaim = {
  clearCookie: boolean;
  /** "applied", the reason the invite was refused, or null when nothing concluded. */
  status: string | null;
};

const AUTH_EVENT_STEP_MAX_LENGTH = 64;

/**
 * Claims the invite this browser opened before signing up and says how it
 * went, so the redirect can tell the new account. A claim that cannot run
 * (attribution down) keeps the cookie for the next sign-in: authentication must
 * not depend on it.
 */
export async function claimPendingReferralForAuth(
  request: Request,
  userId: string,
): Promise<PendingReferralClaim> {
  const visitToken = readReferralVisitCookie(request.headers.get('cookie'));
  if (!visitToken) return { clearCookie: false, status: null };

  try {
    const outcome = await claimReferralForUser({
      adminSupabase: createServiceClient(),
      userId,
      visitToken,
    });
    return { clearCookie: outcome.clearCookie, status: referralClaimStatus(outcome) };
  } catch (error) {
    logBackendError('post_auth_referral_finalization_deferred', { error });
    return { clearCookie: false, status: null };
  }
}

// The app sends where its sign-in screen was headed; this is the same answer:
// the path without a query that can carry what someone searched for.
function authEventStep(next: string) {
  return (next.split(/[?#]/, 1)[0] || '/').slice(0, AUTH_EVENT_STEP_MAX_LENGTH);
}

// The events route keys its rows and its rate limit by an installation id, and
// a browser has none. One derived from the account keeps a person's web
// sign-ins on one key without storing anything the row does not already hold.
function webInstallationId(userId: string) {
  return `fid_${createHash('sha256').update(`web-auth:${userId}`).digest('hex')}`;
}

/**
 * Counts a finished web sign-in as `auth_succeeded` through the onboarding
 * events route, after the redirect has been answered. Never throws: a sign-in
 * must not wait on, or fail because of, its analytics.
 */
export async function recordWebAuthSucceeded({
  next,
  origin,
  supabase,
  userId,
}: {
  next: string;
  origin: string;
  supabase: Pick<SupabaseClient, 'auth'>;
  userId: string;
}): Promise<void> {
  try {
    // The events route verifies the bearer itself and links the row to the account.
    const { data } = await supabase.auth.getSession();
    const accessToken = data.session?.access_token;
    const eventRequest = new Request(new URL('/api/onboarding/events', origin), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify({
        clientEventId: randomUUID(),
        installationId: webInstallationId(userId),
        eventName: 'auth_succeeded',
        platform: 'web',
        step: authEventStep(next),
        occurredAt: new Date().toISOString(),
      }),
    });
    // The adapter answers its own failures (logged, never thrown).
    after(() => postOnboardingEventRouteResponse({ request: eventRequest }));
  } catch (error) {
    logBackendError('web_auth_succeeded_event_not_recorded', { error });
  }
}
