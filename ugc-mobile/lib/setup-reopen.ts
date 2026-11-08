import type { OnboardingDestination } from './onboarding-destination';

/**
 * An unfinished creator setup opens again once per app start (owner,
 * 2026-11-08), now that Home and Settings no longer carry a card for it: a
 * signed-in account with no creator name yet. Credits still to claim are
 * offered by the welcome popup over Home instead (owner, 2026-11-09). Once the setup screen has been shown in this run of the app, by this or
 * by a sign-in, it is not opened again until the next start, so leaving it
 * ("Try again later", Android's back key) is not undone at once.
 */
let setupShownThisRun = false;

/** Called by the setup screen whenever it opens. */
export function markSetupShownThisRun() {
  setupShownThisRun = true;
}

export function wasSetupShownThisRun() {
  return setupShownThisRun;
}

/** For tests: a fresh app start. */
export function resetSetupShownThisRun() {
  setupShownThisRun = false;
}

export function shouldReopenSetup(destination: OnboardingDestination, shownThisRun: boolean): boolean {
  return !shownThisRun && destination === 'identity';
}
