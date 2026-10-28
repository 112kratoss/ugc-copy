import 'server-only';

import type { CreatorWelcome } from '@/components/CreatorWelcomeCard';
import { requestHasAuthHint } from '@/components/RouteAuthBoundary';
import { CREATOR_WELCOME_PARAM } from '@/lib/auth-onboarding';
import { logBackendError } from '@/lib/backend-logger';
import { REFERRAL_CLAIM_STATUS_PARAM } from '@/lib/referral';
import { loadWelcomeCreditAmount } from '@/lib/welcome-credit-program-server';

type CreatorSearchParams = Record<string, string | string[] | undefined>;

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The post-auth redirect's `?welcome=1`, with the invite's outcome when it carried one. */
export function readCreatorWelcome(params: CreatorSearchParams): CreatorWelcome | null {
  if (firstValue(params[CREATOR_WELCOME_PARAM]) !== '1') return null;
  const referral = firstValue(params[REFERRAL_CLAIM_STATUS_PARAM]) ?? null;
  return { referral: referral && /^[a-z_]{1,64}$/.test(referral) ? referral : null };
}

/**
 * What a new account starts with, for a request with no sign-in cookie: the
 * creator tells a visitor what signing up gives them. Null for anyone who may
 * be signed in, and while the welcome program is off or cannot be read.
 */
export async function loadVisitorWelcomeCredits(): Promise<number | null> {
  if (await requestHasAuthHint()) return null;
  try {
    return await loadWelcomeCreditAmount();
  } catch (error) {
    logBackendError('creator_visitor_welcome_credits_load_failed', { error });
    return null;
  }
}
