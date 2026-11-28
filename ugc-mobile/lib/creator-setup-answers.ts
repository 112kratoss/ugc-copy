import { isIdentityDeferredInMetadata, resolveOnboardingDestination } from './onboarding-destination';
import type { InstallOnboardingState } from './onboarding-state';
import type { ProfileResponse, WelcomeCreditResponse } from './types';

/**
 * The creator setup's two answers, read by the sign-in page before it leaves.
 *
 * A sign-in from the sign-in page (`components/sign-in-wall.tsx`) went on to `app/onboarding.tsx`,
 * which opened on "Preparing your creator setup", read the account's profile and welcome credits,
 * and, for every account already set up, went straight back out to Home: a card that flashed for
 * about half a second on the way in (owner's video, 2026-11-28). The page reads the same two
 * answers itself now, under the spinner of the button that was pressed, and goes straight to the
 * return when the setup has nothing to ask. When it has, the answers are handed to onboarding,
 * which opens on the creator-name step itself.
 *
 * Pure (no Expo or React Native imports), so vitest covers it.
 */

export interface CreatorSetupAnswers {
  profile: ProfileResponse;
  welcome: WelcomeCreditResponse;
}

interface SetupAnswersSource {
  getProfile(): Promise<ProfileResponse>;
  getWelcomeCredits(): Promise<WelcomeCreditResponse>;
}

/**
 * How long the sign-in page waits for the answers before handing the question to onboarding,
 * whose card says what failed and offers Try again and Skip.
 */
export const CREATOR_SETUP_CHECK_TIMEOUT_MS = 6_000;

/** How long answers handed to onboarding stay good: the hand-off is one navigation away. */
export const CREATOR_SETUP_HANDOFF_MAX_AGE_MS = 30_000;

/**
 * Both answers, read together as onboarding reads them; `null` when either fails or neither
 * arrives within the timeout (onboarding then reads them itself, with its own error card).
 */
export async function readCreatorSetupAnswers(
  api: SetupAnswersSource,
  { timeoutMs = CREATOR_SETUP_CHECK_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<CreatorSetupAnswers | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  // Started inside the chain, so a request that throws as it is made is a failed answer too.
  const answers = Promise.resolve()
    .then(() => Promise.all([api.getProfile(), api.getWelcomeCredits()]))
    .then(([profile, welcome]): CreatorSetupAnswers => ({ profile, welcome }))
    .catch(() => null);
  try {
    return await Promise.race([answers, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether the setup has a step for this account: the creator name, unless it is done or "Set up
 * later" is on record for it (on this install or on the account). Credits still to claim are not a
 * step: the popup over the return offers them (owner, 2026-11-09), as onboarding's own exit did.
 */
export function creatorSetupHasStep(
  answers: CreatorSetupAnswers,
  {
    local,
    accountMetadata,
  }: {
    local: Pick<InstallOnboardingState, 'identityDeferredAt' | 'identityDeferredFor' | 'status'>;
    /** The signed-in account's `user_metadata`, when it is the account the answers describe. */
    accountMetadata: unknown;
  },
): boolean {
  return resolveOnboardingDestination({
    hasUser: true,
    userId: answers.profile.id,
    welcome: answers.welcome,
    local,
    identityDeferredOnAccount: isIdentityDeferredInMetadata(accountMetadata),
  }) === 'identity';
}

let handedOff: { answers: CreatorSetupAnswers; at: number } | null = null;

/** Keep the answers for the onboarding screen the sign-in page is about to open. */
export function handOffCreatorSetupAnswers(answers: CreatorSetupAnswers, now: number = Date.now()) {
  handedOff = { answers, at: now };
}

/**
 * The answers handed over for this account, while they are fresh; `null` otherwise. Reading leaves
 * them in place, so a screen built twice reads the same answers both times.
 */
export function peekCreatorSetupAnswers(userId: string, now: number = Date.now()): CreatorSetupAnswers | null {
  const entry = handedOff;
  if (!entry || entry.answers.profile.id !== userId) return null;
  const age = now - entry.at;
  if (age < 0 || age > CREATOR_SETUP_HANDOFF_MAX_AGE_MS) return null;
  return entry.answers;
}

/** Forget handed answers once onboarding has opened on them. */
export function clearCreatorSetupAnswers() {
  handedOff = null;
}
