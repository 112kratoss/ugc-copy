import type { WelcomeCreditStatus } from '@/lib/onboarding';
import { supabase } from '@/lib/supabase';

/** `/api/credits/welcome` and its claim, as the popup reads them. */
export type WelcomeCreditAnswer = {
  status: WelcomeCreditStatus;
  amount: number;
  /** The balance after the grant: the header's new figure after a claim. */
  credits: number;
  identityComplete: boolean;
};

/** A request the server or the network refused, in words a person can act on. */
export class WelcomeCreditsRequestError extends Error {}

const CLAIM_FAILED = 'Your credits could not be added. Try again.';

async function welcomeRequest(path: string, init?: RequestInit): Promise<WelcomeCreditAnswer> {
  const { data } = await supabase.auth.getSession();
  const accessToken = data.session?.access_token;
  if (!accessToken) throw new WelcomeCreditsRequestError('Please sign in again to continue.');
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}`, ...init?.headers },
    });
  } catch {
    throw new WelcomeCreditsRequestError(CLAIM_FAILED);
  }
  const body = await response.json().catch(() => null) as (Partial<WelcomeCreditAnswer> & { error?: unknown }) | null;
  if (!response.ok || !body || typeof body.status !== 'string') {
    throw new WelcomeCreditsRequestError(typeof body?.error === 'string' && body.error ? body.error : CLAIM_FAILED);
  }
  return {
    status: body.status,
    amount: typeof body.amount === 'number' ? body.amount : 25,
    credits: typeof body.credits === 'number' ? body.credits : 0,
    identityComplete: body.identityComplete === true,
  };
}

/** Whether this account has credits to claim, and how many. */
export function readWelcomeCredits(): Promise<WelcomeCreditAnswer> {
  return welcomeRequest('/api/credits/welcome');
}

/** The claim, recorded as made on the web (`credit_grants.source_surface`), as the welcome page's was. */
export function claimWelcomeCredits(): Promise<WelcomeCreditAnswer> {
  return welcomeRequest('/api/credits/welcome/claim', {
    method: 'POST',
    body: JSON.stringify({ sourceSurface: 'web' }),
  });
}
