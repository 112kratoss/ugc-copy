/**
 * One whole-app reload at a time. Two things in the app reload the JS runtime:
 * the OTA gate, into a downloaded update (`lib/use-ota-update-gate.ts`), and a
 * root mounted twice in one runtime (`lib/root-remount-reload.ts`). Either
 * reload tears down everything, so when both want one, the first to claim it
 * does it and the other stands down. A reload that fails gives the claim back.
 *
 * No imports, so both callers and their tests can load it as it is.
 */
let claimed = false;

/** True when the caller may reload now; false when a reload is already under way. */
export function claimAppReload(): boolean {
  if (claimed) return false;
  claimed = true;
  return true;
}

/** A claimed reload did not happen after all. */
export function releaseAppReload() {
  claimed = false;
}

/** Test seam. */
export function resetAppReloadClaim() {
  claimed = false;
}
