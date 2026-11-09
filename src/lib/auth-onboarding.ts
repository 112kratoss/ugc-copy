import {
  getCreatorProfileReadiness,
  getSafeProfileNextPath,
  type CreatorProfileReadinessInput,
} from '@/lib/profile';
import { CREATOR_PAGE_PATHS } from '@/lib/creator-pages';
import { REFERRAL_CLAIM_STATUS_PARAM } from '@/lib/referral-claim-copy';

export const DEFAULT_AUTH_NEXT_PATH = '/create';
export const PROFILE_ONBOARDING_SKIPPED_VERSION = 1;
export const PROFILE_ONBOARDING_SKIPPED_METADATA_KEY = 'creator_profile_onboarding_skipped_version';

/**
 * The creators a visitor uses signed out (owner, 2026-10-28). A sign-up started
 * at a creator's sign-up sheet comes straight back to it: the creator asks for
 * the name and handle itself, in one card that also adds the welcome credits,
 * instead of profile setup and the welcome page coming first. The sheet marks
 * its own way back with `handover`, so a sign-in that only returns to a creator
 * (a remix link, the top bar's Sign in) keeps the usual onboarding.
 */
const CREATOR_PATHS = new Set<string>(CREATOR_PAGE_PATHS);

/** The query flag that has a creator greet an account back from sign-up. */
export const CREATOR_WELCOME_PARAM = 'welcome';

/** The sign-up sheet's mark on its way back: the nonce the visitor's saved draft is handed over by. */
export const CREATOR_HANDOVER_PARAM = 'handover';

/** A link's own settings. The visitor's saved draft carries them back instead, edits included. */
const CREATOR_LINK_PREFILL_PARAMS = ['prompt', 'model', 'aspectRatio', 'duration'] as const;

const PATH_BASE = 'https://magicbooklet.local';

function toPath(url: URL) {
  return `${url.pathname}${url.search}${url.hash}`;
}

export function isCreatorPath(path: string): boolean {
  try {
    return CREATOR_PATHS.has(new URL(path, PATH_BASE).pathname);
  } catch {
    return false;
  }
}

/** A creator path that the creators' sign-up sheet sent the sign-in from. */
export function isCreatorSignUpReturn(path: string): boolean {
  try {
    const url = new URL(path, PATH_BASE);
    return CREATOR_PATHS.has(url.pathname) && Boolean(url.searchParams.get(CREATOR_HANDOVER_PARAM));
  } catch {
    return false;
  }
}

export function withCreatorWelcome(path: string): string {
  const url = new URL(path, PATH_BASE);
  url.searchParams.set(CREATOR_WELCOME_PARAM, '1');
  return toPath(url);
}

/** The address without the flags a return from sign-up brought: the welcome, the invite's outcome, the hand-over. */
export function withoutCreatorReturnFlags(path: string): string {
  const url = new URL(path, PATH_BASE);
  url.searchParams.delete(CREATOR_WELCOME_PARAM);
  url.searchParams.delete(REFERRAL_CLAIM_STATUS_PARAM);
  url.searchParams.delete(CREATOR_HANDOVER_PARAM);
  return toPath(url);
}

/**
 * Where the creators' sign-up sheet comes back to: this creator, without an
 * earlier return's flags, and with the hand-over's nonce when the page's draft
 * is the visitor's. A link's own settings are left off then: the draft carries
 * them, edits included, and the page would put the link's values over it.
 */
export function creatorSignUpReturnPath(path: string, handoverNonce: string | null): string {
  const url = new URL(withoutCreatorReturnFlags(path), PATH_BASE);
  if (handoverNonce) {
    CREATOR_LINK_PREFILL_PARAMS.forEach((name) => url.searchParams.delete(name));
    url.searchParams.set(CREATOR_HANDOVER_PARAM, handoverNonce);
  }
  return `${url.pathname}${url.search}`;
}

export function hasSkippedProfileOnboarding(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return false;
  }

  const value = (metadata as Record<string, unknown>)[PROFILE_ONBOARDING_SKIPPED_METADATA_KEY];
  return typeof value === 'number' && value >= PROFILE_ONBOARDING_SKIPPED_VERSION;
}

export function getSafeAuthNextPath(
  value: string | null | undefined,
  fallback = DEFAULT_AUTH_NEXT_PATH
): string {
  return getSafeProfileNextPath(value, fallback);
}

/**
 * The creator-name step (owner, 2026-11-09: the app's required name, on the
 * web). A new account passes it after signing in, on its way to `next`, which
 * it then opens with `welcome=1` (`withCreatorWelcome`).
 */
export const CREATOR_NAME_STEP_PATH = '/onboarding';

const PROFILE_PATH = '/profile';
const WELCOME_REWARD_PATH = '/welcome-reward';

/**
 * A first-profile link from before the name step: what sign-in and Home's old
 * welcome card built, `/profile?welcome=1&next=/welcome-reward?next=…`, which
 * always led through the welcome page. The name step's own way back to a
 * `/profile?next=…` it was given also carries `welcome=1`, and is not one
 * (review of #744: it was sent round the step again and lost its welcome).
 */
export function isOldProfileSetupPath(path: string): boolean {
  try {
    const url = new URL(path, PATH_BASE);
    if (url.pathname !== PROFILE_PATH || url.searchParams.get(CREATOR_WELCOME_PARAM) !== '1') return false;
    const nested = url.searchParams.get('next');
    return nested !== null && new URL(nested, PATH_BASE).pathname === WELCOME_REWARD_PATH;
  } catch {
    return false;
  }
}

/**
 * Where the name step leads for `path`: the path itself, or, when it is a setup
 * step (the name step, an old first-profile link), the step's own `next`, so
 * the step never opens itself or the old setup on the way back. An old link's
 * welcome-reward hop goes with it: the page a sign-up returns to greets it now.
 */
export function creatorNameStepNextPath(path: string | null | undefined): string {
  let current = getSafeAuthNextPath(path);
  for (let unwrapped = 0; unwrapped < 3; unwrapped += 1) {
    const url = new URL(current, PATH_BASE);
    const oldSetup = isOldProfileSetupPath(current);
    if (url.pathname !== CREATOR_NAME_STEP_PATH && !oldSetup) return current;
    current = getSafeAuthNextPath(url.searchParams.get('next'));
    if (oldSetup && new URL(current, PATH_BASE).pathname === WELCOME_REWARD_PATH) {
      current = getSafeAuthNextPath(new URL(current, PATH_BASE).searchParams.get('next'));
    }
  }
  return DEFAULT_AUTH_NEXT_PATH;
}

export function buildCreatorNameStepPath(next: string | null | undefined): string {
  return `${CREATOR_NAME_STEP_PATH}?next=${encodeURIComponent(creatorNameStepNextPath(next))}`;
}

export function buildAuthContinuePath(next: string | null | undefined): string {
  const safeNext = getSafeAuthNextPath(next);
  return `/auth/continue?next=${encodeURIComponent(safeNext)}`;
}

export function buildAuthCodeErrorPath(next: string | null | undefined): string {
  const safeNext = getSafeAuthNextPath(next);
  return `/auth/auth-code-error?next=${encodeURIComponent(safeNext)}`;
}

export function isPasswordRecoveryPath(path: string): boolean {
  try {
    return new URL(path, 'https://magicbooklet.local').pathname === '/auth/reset-password';
  } catch {
    return false;
  }
}

export function getPasswordRecoveryNextPath(
  recoveryPath: string,
  fallback = DEFAULT_AUTH_NEXT_PATH
): string {
  const safeRecoveryPath = getSafeAuthNextPath(recoveryPath, fallback);
  if (!isPasswordRecoveryPath(safeRecoveryPath)) {
    return getSafeAuthNextPath(fallback);
  }

  try {
    const recoveryUrl = new URL(safeRecoveryPath, 'https://magicbooklet.local');
    return getSafeAuthNextPath(recoveryUrl.searchParams.get('next'), fallback);
  } catch {
    return getSafeAuthNextPath(fallback);
  }
}

/**
 * Where a sign-in goes: an account without a creator name passes the name step
 * first, on its way to `next` (a creator's sign-up return too, hand-over nonce
 * and all). An account that chose "Set up later" before the name was required
 * (`identityDeferred`, from its metadata) is not sent there, as in the app; a
 * creator it returns to still greets it.
 */
export function resolvePostAuthPath(
  profile: CreatorProfileReadinessInput | null | undefined,
  next: string | null | undefined,
  { identityDeferred = false }: { identityDeferred?: boolean } = {}
): string {
  const safeNext = getSafeAuthNextPath(next);

  // Password recovery must not be intercepted by the name step. The recovery
  // session is deliberately short-lived and should land on the password form.
  if (isPasswordRecoveryPath(safeNext)) {
    return safeNext;
  }

  const destination = creatorNameStepNextPath(safeNext);
  if (getCreatorProfileReadiness(profile).publicPublishReady) {
    return destination;
  }

  if (identityDeferred) {
    return isCreatorSignUpReturn(destination) ? withCreatorWelcome(destination) : destination;
  }

  return buildCreatorNameStepPath(destination);
}
