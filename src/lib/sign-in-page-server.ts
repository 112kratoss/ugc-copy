import 'server-only';

import { unstable_cache } from 'next/cache';

import { logBackendError } from '@/lib/backend-logger';
import { loadWelcomeCreditAmount } from '@/lib/welcome-credit-program-server';

// The grant changes only with the program, so the page is answered from the data cache, as the
// creators are (`loadVisitorWelcomeCredits` in creator-page-server.ts, which this page does not
// import: that module brings the creators' catalog and quote code into the route).
const loadCachedWelcomeCreditAmount = unstable_cache(loadWelcomeCreditAmount, ['sign-in-welcome-credits'], {
  revalidate: 300,
});

/**
 * Where the wall's loop starts for this visit, 0 to 1, as each open of the app's page starts
 * somewhere new. Request data like the welcome amount: the page renders once per request
 * (`force-dynamic`) and the client hydrates the HTML it drew, so the two always agree.
 */
export function pickSignInWallStart(): number {
  return Math.random();
}

/**
 * What the sign-in page promises a new account ("Join free and get 25 credits to start"): the
 * welcome program's own amount, so the page says what the creators say. Null while the program is
 * off or cannot be read, and the page then makes no promise.
 */
export async function loadSignInWelcomeCredits(): Promise<number | null> {
  try {
    return await loadCachedWelcomeCreditAmount();
  } catch (error) {
    logBackendError('sign_in_welcome_credits_load_failed', { error });
    return null;
  }
}
