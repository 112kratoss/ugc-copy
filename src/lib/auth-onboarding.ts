import {
  getCreatorProfileReadiness,
  getSafeProfileNextPath,
  type CreatorProfileReadinessInput,
} from '@/lib/profile';

export const DEFAULT_AUTH_NEXT_PATH = '/create';
export const PROFILE_ONBOARDING_SKIPPED_VERSION = 1;
export const PROFILE_ONBOARDING_SKIPPED_METADATA_KEY = 'creator_profile_onboarding_skipped_version';

/**
 * The creators a visitor uses signed out (owner, 2026-10-28). A sign-up started
 * there comes straight back to it: the creator asks for the name and handle
 * itself, in one card that also adds the welcome credits, instead of profile
 * setup and the welcome page coming first.
 */
const CREATOR_PATHS = new Set(['/create-image', '/create-video', '/create-motion']);

/** The query flag that has a creator greet an account back from sign-up. */
export const CREATOR_WELCOME_PARAM = 'welcome';

export function isCreatorPath(path: string): boolean {
  try {
    return CREATOR_PATHS.has(new URL(path, 'https://magicbooklet.local').pathname);
  } catch {
    return false;
  }
}

export function withCreatorWelcome(path: string): string {
  const url = new URL(path, 'https://magicbooklet.local');
  url.searchParams.set(CREATOR_WELCOME_PARAM, '1');
  return `${url.pathname}${url.search}${url.hash}`;
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

  if (isCreatorPath(safeNext)) {
    return withCreatorWelcome(safeNext);
  }

  return isProfileSetupPath(safeNext)
    ? buildProfileSetupPath(getNestedProfileNextPath(safeNext))
    : buildProfileSetupPath(safeNext);
}
