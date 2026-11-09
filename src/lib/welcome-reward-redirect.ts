import { withCreatorWelcome } from '@/lib/auth-onboarding';
import { REFERRAL_CLAIM_REASON_PATTERN, REFERRAL_CLAIM_STATUS_PARAM } from '@/lib/referral-claim-copy';

const PATH_BASE = 'https://magicbooklet.local';

/**
 * Where an old welcome-page link (`/welcome-reward?next=…`) sends a signed-in
 * account: the page it was to go on to, marked as the page a sign-up returned
 * to (`welcome=1`), with the invite's outcome it carried, so the
 * welcome-credits popup offers the credits there (owner, 2026-11-09). `next`
 * is already a safe path (`getSafeProfileNextPath`).
 */
export function welcomeRewardDestination(next: string, referral: string | null | undefined): string {
  const url = new URL(withCreatorWelcome(next), PATH_BASE);
  if (referral && REFERRAL_CLAIM_REASON_PATTERN.test(referral)) url.searchParams.set(REFERRAL_CLAIM_STATUS_PARAM, referral);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The welcome page itself, to sign in from and come back to: `next` and the invite's outcome kept. */
export function welcomeRewardSignInReturn(next: string, referral: string | null | undefined): string {
  const url = new URL('/welcome-reward', PATH_BASE);
  url.searchParams.set('next', next);
  if (referral && REFERRAL_CLAIM_REASON_PATTERN.test(referral)) url.searchParams.set(REFERRAL_CLAIM_STATUS_PARAM, referral);
  return `${url.pathname}${url.search}`;
}
