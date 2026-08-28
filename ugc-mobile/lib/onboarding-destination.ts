import type { InstallOnboardingState } from './onboarding-state';
import type { WelcomeCreditResponse } from './types';

/**
 * Where the creator-setup entry points should send someone — or whether they
 * should appear at all.
 *
 * `pending` is not a polite `none`. A missing welcome response means offline or
 * a 500, and answering "nothing to do" to an unknown is how the resume card
 * used to flicker in and out and shift the Home feed under a thumb. The card
 * renders nothing until it actually knows.
 */
export type OnboardingDestination = 'intro' | 'identity' | 'reward' | 'none' | 'pending';

export interface OnboardingDestinationInput {
  /** A *registered* user. Guests are install-local and never resolve past `intro`. */
  hasUser: boolean;
  welcome: Pick<WelcomeCreditResponse, 'status' | 'identityComplete'> | null;
  local: Pick<InstallOnboardingState, 'identityDeferredAt'>;
}

/**
 * Resolve the destination from what is actually missing, never from a stored
 * cursor.
 *
 * The old flow asked `state.lastStep >= 4`, a number kept per install, so one
 * account routed two ways on two devices. Every input here is derived: the
 * session, and the account-scoped welcome response — which already carries
 * `identityComplete`, so one request answers both questions and no profile
 * fetch is needed.
 *
 * Identity is checked *above* completion on purpose. Claiming a handle is
 * separate from claiming the Creator Pack, and most accounts that can never
 * claim the pack (created before the program activated) are also the ones still
 * carrying a generated `creator-xxxxxxxx` handle. Suppressing the card for them
 * would silence the one prompt that is genuinely actionable.
 *
 * The result is an **entry** decision: resolve once when the screen opens and
 * hold it. Re-deriving on every render would eject someone mid-celebration the
 * instant `claimCredits` flips `eligible` to `claimed`.
 */
export function resolveOnboardingDestination({
  hasUser,
  welcome,
  local,
}: OnboardingDestinationInput): OnboardingDestination {
  if (!hasUser) return 'intro';
  if (!welcome) return 'pending';
  if (!welcome.identityComplete && !local.identityDeferredAt) return 'identity';
  if (welcome.status === 'eligible') return 'reward';
  return 'none';
}

/** Whether an entry point (Home card, Settings row) should render at all. */
export function isOnboardingActionable(destination: OnboardingDestination): boolean {
  return destination === 'intro' || destination === 'identity' || destination === 'reward';
}
