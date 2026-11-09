import clsx from 'clsx';
import { Loader2 } from 'lucide-react';

import AppleLogo from '@/components/AppleLogo';
import type { SignInProvider } from '@/lib/provider-sign-in';

/** A sign-in under way on the page, from either half: one at a time. */
export type SignInInFlight = SignInProvider | 'email' | null;

/**
 * Every button on the sign-in page, a compact centred pill, as the app draws them (owner,
 * 2026-11-08: "reduce the button lengths … a bit modern"; `ugc-mobile/components/sign-in-parts.tsx`):
 * 44 px tall and at most 270 wide on a phone, a step larger on a wide screen, where a mouse aims
 * at them from further off.
 */
export const SIGN_IN_PILL = 'flex h-11 w-full items-center justify-center gap-2.5 rounded-full text-base font-semibold tracking-[-0.0125em] transition md:h-12';
export const SIGN_IN_PILLS = 'mx-auto flex w-full max-w-[270px] flex-col gap-2.5 md:max-w-[300px]';

/**
 * Apple and Google, white on the dark wall: Apple's rule for its button on a dark background,
 * and Google's mark in its own colours on a matching white button (its branding guidelines allow
 * a pill and "Continue with Google"). Apple leads, as on the app's page. While a sign-in is under
 * way every way in waits, and the one under way shows a spinner in place of its label.
 */
export function SignInProviderButtons({ inFlight, onContinue, describedBy }: {
  inFlight: SignInInFlight;
  onContinue: (provider: SignInProvider) => void;
  /** The agreement every provider button carries: either one makes an account. */
  describedBy: string;
}) {
  const busy = inFlight !== null;
  const button = (provider: SignInProvider, label: string, mark: React.ReactNode) => (
    <button
      type="button"
      onClick={() => onContinue(provider)}
      disabled={busy}
      aria-describedby={describedBy}
      aria-busy={inFlight === provider || undefined}
      className={clsx(SIGN_IN_PILL, 'ui-focus-ring bg-white text-black hover:bg-zinc-200 disabled:cursor-not-allowed', busy && inFlight !== provider && 'opacity-50')}
    >
      {inFlight === provider ? <Loader2 aria-hidden className="h-5 w-5 animate-spin" /> : mark}
      {label}
    </button>
  );
  return (
    <div className={SIGN_IN_PILLS}>
      {button('apple', 'Continue with Apple', <AppleLogo className="h-[18px] w-[18px]" />)}
      {button('google', 'Continue with Google', <GoogleMark className="h-[17px] w-[17px]" />)}
    </div>
  );
}

/**
 * Google's "G" in Google's four colours, never recoloured (its sign-in branding guidelines), the
 * same drawing as the app's (`ugc-mobile/components/google-g-mark.tsx`).
 */
export function GoogleMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}
