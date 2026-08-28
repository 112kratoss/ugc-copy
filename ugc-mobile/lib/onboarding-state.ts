import type { OnboardingGoal, OnboardingStatus } from './types';

export const ONBOARDING_FLOW_VERSION = 1;
export const ONBOARDING_STORAGE_KEY = 'magicbooklet.onboarding.install.v1';

export interface InstallOnboardingState {
  flowVersion: number;
  status: OnboardingStatus;
  /**
   * Which intro card to resume on: 0 = welcome, 1 = goal picker.
   *
   * This used to be `lastStep`, a 0–6 cursor that also decided whether a signed
   * -in creator entered the authenticated stages at all. That made routing a
   * property of the *install* rather than the account, so the same person hit
   * the guest welcome screen on one device and the reward screen on another.
   * The destination is derived now (see `onboarding-destination.ts`); this is
   * only a hint for where to resume inside the intro.
   */
  introStep: number;
  goal: OnboardingGoal;
  startedAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  /**
   * When the creator chose "Choose a name later".
   *
   * Without a record of the deferral the resume card re-prompts on the next
   * render, which is the same nag loop by a shorter route: "later" has to
   * actually mean later. Settings still opens the flow on demand.
   */
  identityDeferredAt: string | null;
}

export const defaultInstallOnboardingState: InstallOnboardingState = {
  flowVersion: ONBOARDING_FLOW_VERSION,
  status: 'not_started',
  introStep: 0,
  goal: 'image',
  startedAt: null,
  updatedAt: null,
  completedAt: null,
  identityDeferredAt: null,
};

function isGoal(value: unknown): value is OnboardingGoal {
  return value === 'image' || value === 'video' || value === 'motion';
}

function isStatus(value: unknown): value is OnboardingStatus {
  return value === 'not_started' || value === 'in_progress' || value === 'skipped' || value === 'completed';
}

function safeTimestamp(value: unknown) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

function clampIntroStep(value: number) {
  return Math.min(1, Math.max(0, Math.floor(value)));
}

/**
 * A finished run is finished, whatever `status` claims.
 *
 * Installs in the field carry rows that contradict themselves — a set
 * `completedAt` beside a `skipped`/`in_progress` status — because every writer
 * could freely walk the status backwards. `completedAt` is the durable signal,
 * so it wins, and the database agrees: the only constraint ever written was
 * `status <> 'completed' OR completed_at IS NOT NULL`, never the reverse.
 */
function settleStatus(
  current: Pick<InstallOnboardingState, 'status' | 'completedAt'>,
  requested: OnboardingStatus,
): OnboardingStatus {
  const finished = current.status === 'completed' || current.completedAt !== null;
  return finished ? 'completed' : requested;
}

export function parseInstallOnboardingState(value: string | null): InstallOnboardingState {
  if (!value) return defaultInstallOnboardingState;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed.flowVersion !== ONBOARDING_FLOW_VERSION) return defaultInstallOnboardingState;
    const completedAt = safeTimestamp(parsed.completedAt);
    const rawStatus = isStatus(parsed.status) ? parsed.status : 'not_started';
    // `lastStep` is the pre-rename field. Anything past the welcome card
    // resumes on the goal picker; the finer-grained values only ever described
    // stages that are derived now.
    const legacyStep = typeof parsed.lastStep === 'number' ? parsed.lastStep : undefined;
    const rawStep = typeof parsed.introStep === 'number' ? parsed.introStep : legacyStep;
    return {
      flowVersion: ONBOARDING_FLOW_VERSION,
      // Heal on read, not on the next write: an install that never writes again
      // would otherwise keep contradicting itself forever.
      status: completedAt ? 'completed' : rawStatus,
      introStep: typeof rawStep === 'number' ? clampIntroStep(rawStep) : 0,
      goal: isGoal(parsed.goal) ? parsed.goal : 'image',
      startedAt: safeTimestamp(parsed.startedAt),
      updatedAt: safeTimestamp(parsed.updatedAt),
      completedAt,
      identityDeferredAt: safeTimestamp(parsed.identityDeferredAt),
    };
  } catch {
    return defaultInstallOnboardingState;
  }
}

/**
 * Whether the Creator Pack card should advertise a claimable reward.
 *
 * Only `eligible` qualifies. `unavailable` used to count too, which meant the
 * card read "Your Creator Pack is waiting" whenever the grant program was off
 * or the lookup failed — and tapping it routed into onboarding, where the claim
 * button is hidden for exactly those statuses. The card then returned on every
 * visit with no way to clear it.
 *
 * `requires_account` is excluded as well: a guest cannot claim, and the
 * "create an account" prompt belongs on the auth surfaces, not on a card that
 * promises credits.
 */
export function isWelcomeRewardPending(status: string | null | undefined): boolean {
  return status === 'eligible';
}

export function mergeInstallOnboardingState(
  current: InstallOnboardingState,
  update: Partial<InstallOnboardingState>,
  now = new Date().toISOString(),
): InstallOnboardingState {
  const status = settleStatus(current, update.status ?? current.status);
  return {
    ...current,
    ...update,
    flowVersion: ONBOARDING_FLOW_VERSION,
    status,
    introStep: clampIntroStep(update.introStep ?? current.introStep),
    goal: isGoal(update.goal) ? update.goal : current.goal,
    startedAt: current.startedAt ?? (status === 'in_progress' ? now : null),
    updatedAt: now,
    completedAt: status === 'completed'
      ? current.completedAt ?? update.completedAt ?? now
      : current.completedAt,
    identityDeferredAt: update.identityDeferredAt !== undefined
      ? update.identityDeferredAt
      : current.identityDeferredAt,
  };
}

export interface RemoteOnboardingState {
  status: OnboardingStatus;
  goal: OnboardingGoal | null;
  completedAt: string | null;
}

/**
 * Fold the account's server state into this install's state.
 *
 * Deliberately **promote-only**. Nothing in the app ever PATCHes `skipped`, and
 * the server serializes a missing row as `not_started`, so a server value that
 * looks "earlier" carries no information — adopting it wholesale would
 * resurrect the flow for everyone who ever skipped it. The server can therefore
 * only tell us a run *finished*; it can never tell us one un-finished.
 *
 * Returns `current` by identity when nothing changes, so the foreground
 * refetch that keeps two devices in step does not cost a re-render and an
 * AsyncStorage write on every app focus.
 */
export function reconcileInstallOnboardingState(
  current: InstallOnboardingState,
  remote: RemoteOnboardingState,
  now = new Date().toISOString(),
): InstallOnboardingState {
  const remoteFinished = remote.status === 'completed' || remote.completedAt !== null;
  const goalChanged = Boolean(remote.goal) && remote.goal !== current.goal;

  if (!remoteFinished) {
    return goalChanged ? mergeInstallOnboardingState(current, { goal: remote.goal! }, now) : current;
  }
  const alreadyFinished = current.status === 'completed' && current.completedAt !== null;
  if (alreadyFinished && !goalChanged) return current;

  return mergeInstallOnboardingState(current, {
    status: 'completed',
    completedAt: current.completedAt ?? remote.completedAt ?? now,
    ...(goalChanged ? { goal: remote.goal! } : {}),
  }, now);
}
