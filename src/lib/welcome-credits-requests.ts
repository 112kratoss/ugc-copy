import type { WelcomeCreditStatus } from '@/lib/onboarding';
import { supabase } from '@/lib/supabase';
import { recordWelcomeAnswer } from '@/lib/welcome-promise';

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
/** As the app's API client gives up (`DEFAULT_API_REQUEST_TIMEOUT_MS`). */
export const WELCOME_REQUEST_TIMEOUT_MS = 30_000;

async function welcomeRequest(path: string, init?: RequestInit): Promise<WelcomeCreditAnswer> {
  const { data } = await supabase.auth.getSession();
  const accessToken = data.session?.access_token;
  const askedFor = data.session?.user?.id ?? null;
  if (!accessToken) throw new WelcomeCreditsRequestError('Please sign in again to continue.');
  // Given up after the app's API timeout (`ugc-mobile/lib/api-client.ts`): a stalled claim holds
  // the popup's Close, so it must end in "Try again" rather than hold the page (review of #744).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WELCOME_REQUEST_TIMEOUT_MS);
  let response: Response;
  let body: (Partial<WelcomeCreditAnswer> & { error?: unknown }) | null;
  try {
    try {
      response = await fetch(path, {
        ...init,
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}`, ...init?.headers },
      });
    } catch {
      throw new WelcomeCreditsRequestError(CLAIM_FAILED);
    }
    body = await response.json().catch(() => null) as (Partial<WelcomeCreditAnswer> & { error?: unknown }) | null;
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok || !body || typeof body.status !== 'string') {
    throw new WelcomeCreditsRequestError(typeof body?.error === 'string' && body.error ? body.error : CLAIM_FAILED);
  }
  const answer: WelcomeCreditAnswer = {
    status: body.status,
    amount: typeof body.amount === 'number' ? body.amount : 25,
    credits: typeof body.credits === 'number' ? body.credits : 0,
    identityComplete: body.identityComplete === true,
  };
  // This browser remembers what its account was told, so the signed-out top bar, sign-in page
  // and Home shelf stop promising credits that were had (`welcome-promise.ts`, the app's #738).
  // Only while the account that asked is still the one signed in: an answer that outlived a
  // sign-out or an account switch says nothing about the person here now.
  const { data: now } = await supabase.auth.getSession();
  if (askedFor && now.session?.user?.id === askedFor) recordWelcomeAnswer(answer.status);
  return answer;
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
