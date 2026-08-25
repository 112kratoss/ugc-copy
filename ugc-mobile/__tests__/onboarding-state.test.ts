import { describe, expect, it } from 'vitest';

import {
  defaultInstallOnboardingState,
  isWelcomeRewardPending,
  mergeInstallOnboardingState,
  parseInstallOnboardingState,
} from '../lib/onboarding-state';

describe('install onboarding state', () => {
  it('fails open to a new versioned state for corrupt storage', () => {
    expect(parseInstallOnboardingState('{bad')).toEqual(defaultInstallOnboardingState);
    expect(parseInstallOnboardingState(JSON.stringify({ flowVersion: 0, status: 'completed' })))
      .toEqual(defaultInstallOnboardingState);
  });

  it('normalizes invalid fields without losing a valid goal', () => {
    expect(parseInstallOnboardingState(JSON.stringify({
      flowVersion: 1,
      status: 'in_progress',
      lastStep: 99,
      goal: 'video',
      startedAt: 'nope',
    }))).toMatchObject({ status: 'in_progress', lastStep: 6, goal: 'video', startedAt: null });
  });

  it('records completion timestamps once', () => {
    const first = mergeInstallOnboardingState(defaultInstallOnboardingState, { status: 'completed' }, '2026-07-13T10:00:00.000Z');
    const second = mergeInstallOnboardingState(first, { status: 'completed' }, '2026-07-13T11:00:00.000Z');
    expect(first.completedAt).toBe('2026-07-13T10:00:00.000Z');
    expect(second.completedAt).toBe(first.completedAt);
  });
});

describe('welcome reward pending', () => {
  it('advertises a claimable Creator Pack only while it is eligible', () => {
    expect(isWelcomeRewardPending('eligible')).toBe(true);
  });

  it('does not advertise a reward the claim screen would refuse', () => {
    // `unavailable` is the regression this pins: it used to read as pending, so
    // the card promised a reward, routed into onboarding, and found the claim
    // button hidden — reappearing on every visit with no way to dismiss it.
    for (const status of ['unavailable', 'requires_account', 'not_eligible', 'legacy_ineligible', 'claimed', 'already_claimed']) {
      expect(isWelcomeRewardPending(status)).toBe(false);
    }
  });

  it('treats a missing status as nothing to claim', () => {
    expect(isWelcomeRewardPending(null)).toBe(false);
    expect(isWelcomeRewardPending(undefined)).toBe(false);
  });
});
