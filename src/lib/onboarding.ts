export const ONBOARDING_FLOW_VERSION = 1;
export const ONBOARDING_VARIANT = 'creator_pack_v1';
export const WELCOME_CREDIT_PROGRAM_KEY = 'welcome_credits_v1';

export const onboardingGoals = ['image', 'video', 'motion'] as const;
export type OnboardingGoal = (typeof onboardingGoals)[number];

export const onboardingStatuses = ['not_started', 'in_progress', 'skipped', 'completed'] as const;
export type OnboardingStatus = (typeof onboardingStatuses)[number];

export const onboardingEventNames = [
  'started',
  'screen_viewed',
  'skipped',
  'auth_started',
  'auth_succeeded',
  'auth_canceled',
  'username_saved',
  'username_conflict',
  'reward_viewed',
  'reward_claimed',
  'reward_deferred',
  'reward_failed',
  'guided_creator_opened',
  'first_generation_started',
  'first_generation_succeeded',
] as const;
export type OnboardingEventName = (typeof onboardingEventNames)[number];

export type WelcomeCreditStatus =
  | 'eligible'
  | 'claimed'
  | 'already_claimed'
  | 'legacy_ineligible'
  /**
   * The caller is a guest (anonymous auth user). The grant RPC refuses these
   * outright (20260811120000), so surfacing `not_eligible` here sent guests to
   * "finish your creator name" — a gate they cannot pass, because
   * `PATCH /api/profile` also rejects anonymous users. Registering is the only
   * route, so it gets its own status and its own copy.
   */
  | 'requires_account'
  | 'not_eligible'
  | 'unavailable';

export function isOnboardingGoal(value: unknown): value is OnboardingGoal {
  return typeof value === 'string' && onboardingGoals.includes(value as OnboardingGoal);
}

export function isOnboardingStatus(value: unknown): value is OnboardingStatus {
  return typeof value === 'string' && onboardingStatuses.includes(value as OnboardingStatus);
}

export function isOnboardingEventName(value: unknown): value is OnboardingEventName {
  return typeof value === 'string' && onboardingEventNames.includes(value as OnboardingEventName);
}

export function hasClaimedCreatorIdentity(profile: {
  username?: string | null;
  display_name?: string | null;
}) {
  const username = profile.username?.trim() ?? '';
  return /^[a-z0-9-]{3,24}$/.test(username)
    && !/^creator-[a-f0-9]{8}$/.test(username)
    && Boolean(profile.display_name?.trim());
}

export function isValidOnboardingInstallationId(value: unknown): value is string {
  return typeof value === 'string' && /^fid_[a-f0-9]{64}$/.test(value);
}

export function isValidOnboardingClientEventId(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
