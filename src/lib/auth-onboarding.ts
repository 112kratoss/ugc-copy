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

export function buildProfileSetupPath(next: string | null | undefined): string {
  const safeNext = getSafeAuthNextPath(next);
  return `/profile?welcome=1&next=${encodeURIComponent(buildWelcomeRewardPath(safeNext))}`;
}

export function buildWelcomeRewardPath(next: string | null | undefined): string {
  const safeNext = getSafeAuthNextPath(next);
  return `/welcome-reward?next=${encodeURIComponent(safeNext)}`;
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

function isProfileSetupPath(path: string): boolean {
  try {
    return new URL(path, 'https://magicbooklet.local').pathname === '/profile';
  } catch {
    return false;
  }
}

function getNestedProfileNextPath(profilePath: string): string {
  try {
    const profileUrl = new URL(profilePath, 'https://magicbooklet.local');
    const nestedNext = getSafeAuthNextPath(profileUrl.searchParams.get('next'));
    return isProfileSetupPath(nestedNext) ? DEFAULT_AUTH_NEXT_PATH : nestedNext;
  } catch {
    return DEFAULT_AUTH_NEXT_PATH;
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

export function resolvePostAuthPath(
  profile: CreatorProfileReadinessInput | null | undefined,
  next: string | null | undefined
): string {
  const safeNext = getSafeAuthNextPath(next);

  // Password recovery must not be intercepted by profile setup. The recovery
  // session is deliberately short-lived and should land on the password form.
  if (isPasswordRecoveryPath(safeNext)) {
    return safeNext;
  }

  if (getCreatorProfileReadiness(profile).publicPublishReady) {
    return safeNext;
  }

  if (isCreatorSignUpReturn(safeNext)) {
    return withCreatorWelcome(safeNext);
  }

  return isProfileSetupPath(safeNext)
    ? buildProfileSetupPath(getNestedProfileNextPath(safeNext))
    : buildProfileSetupPath(safeNext);
}
