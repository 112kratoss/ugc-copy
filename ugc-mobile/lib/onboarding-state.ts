import type { OnboardingGoal, OnboardingStatus } from './types';

export const ONBOARDING_FLOW_VERSION = 1;
export const ONBOARDING_STORAGE_KEY = 'magicbooklet.onboarding.install.v1';

export interface InstallOnboardingState {
  flowVersion: number;
  status: OnboardingStatus;
  lastStep: number;
  goal: OnboardingGoal;
  startedAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
}

export const defaultInstallOnboardingState: InstallOnboardingState = {
  flowVersion: ONBOARDING_FLOW_VERSION,
  status: 'not_started',
  lastStep: 0,
  goal: 'image',
  startedAt: null,
  updatedAt: null,
  completedAt: null,
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

export function parseInstallOnboardingState(value: string | null): InstallOnboardingState {
  if (!value) return defaultInstallOnboardingState;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed.flowVersion !== ONBOARDING_FLOW_VERSION) return defaultInstallOnboardingState;
    return {
      flowVersion: ONBOARDING_FLOW_VERSION,
      status: isStatus(parsed.status) ? parsed.status : 'not_started',
      lastStep: typeof parsed.lastStep === 'number'
        ? Math.min(6, Math.max(0, Math.floor(parsed.lastStep)))
        : 0,
      goal: isGoal(parsed.goal) ? parsed.goal : 'image',
      startedAt: safeTimestamp(parsed.startedAt),
      updatedAt: safeTimestamp(parsed.updatedAt),
      completedAt: safeTimestamp(parsed.completedAt),
    };
  } catch {
    return defaultInstallOnboardingState;
  }
}

export function mergeInstallOnboardingState(
  current: InstallOnboardingState,
  update: Partial<InstallOnboardingState>,
  now = new Date().toISOString(),
): InstallOnboardingState {
  const status = update.status ?? current.status;
  return {
    ...current,
    ...update,
    flowVersion: ONBOARDING_FLOW_VERSION,
    status,
    lastStep: Math.min(6, Math.max(0, Math.floor(update.lastStep ?? current.lastStep))),
    goal: isGoal(update.goal) ? update.goal : current.goal,
    startedAt: current.startedAt ?? (status === 'in_progress' ? now : null),
    updatedAt: now,
    completedAt: status === 'completed' ? current.completedAt ?? now : current.completedAt,
  };
}
