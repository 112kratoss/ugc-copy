import { describe, expect, it } from 'vitest';

import {
  defaultInstallOnboardingState,
  isWelcomeRewardPending,
  mergeInstallOnboardingState,
  parseInstallOnboardingState,
  reconcileInstallOnboardingState,
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
      introStep: 99,
      goal: 'video',
      startedAt: 'nope',
    }))).toMatchObject({ status: 'in_progress', introStep: 1, goal: 'video', startedAt: null });
  });

  it('resumes the goal picker for installs still carrying the old cursor', () => {
    // `lastStep` was a 0-6 cursor that also decided whether a signed-in creator
    // reached the authenticated stages. Anything past the welcome card resumes
    // on the goal picker now; the rest of its range described stages that are
    // derived from the account instead.
    expect(parseInstallOnboardingState(JSON.stringify({
      flowVersion: 1, status: 'in_progress', lastStep: 5, goal: 'image',
    }))).toMatchObject({ introStep: 1 });
    expect(parseInstallOnboardingState(JSON.stringify({
      flowVersion: 1, status: 'in_progress', lastStep: 0, goal: 'image',
    }))).toMatchObject({ introStep: 0 });
  });

  it('records completion timestamps once', () => {
    const first = mergeInstallOnboardingState(defaultInstallOnboardingState, { status: 'completed' }, '2026-07-13T10:00:00.000Z');
    const second = mergeInstallOnboardingState(first, { status: 'completed' }, '2026-07-13T11:00:00.000Z');
    expect(first.completedAt).toBe('2026-07-13T10:00:00.000Z');
    expect(second.completedAt).toBe(first.completedAt);
  });

  it('heals a stored status that contradicts its own completion stamp', () => {
    // Exactly the shape found on both dev devices: onboarding had finished, but
    // a later write walked the status back, and nothing read `completedAt`. The
    // repair happens on read so an install that never writes again still heals.
    expect(parseInstallOnboardingState(JSON.stringify({
      flowVersion: 1,
      status: 'skipped',
      lastStep: 0,
      goal: 'video',
      completedAt: '2026-08-25T18:05:41.167Z',
    }))).toMatchObject({ status: 'completed', completedAt: '2026-08-25T18:05:41.167Z' });
  });

  it('never walks a finished run backwards', () => {
    const done = mergeInstallOnboardingState(defaultInstallOnboardingState, { status: 'completed' }, '2026-08-16T08:27:09.326Z');
    for (const status of ['in_progress', 'skipped', 'not_started'] as const) {
      const after = mergeInstallOnboardingState(done, { status }, '2026-08-28T06:50:52.097Z');
      expect(after.status).toBe('completed');
      expect(after.completedAt).toBe('2026-08-16T08:27:09.326Z');
    }
  });
});

describe('reconciling install state with the account', () => {
  const local = mergeInstallOnboardingState(
    defaultInstallOnboardingState,
    { status: 'skipped', introStep: 0, goal: 'video' },
    '2026-08-25T18:05:41.167Z',
  );

  it('promotes an install that the account already finished', () => {
    const next = reconcileInstallOnboardingState(local, {
      status: 'completed', goal: 'image', completedAt: '2026-08-16T08:27:09.326Z',
    }, '2026-08-28T07:00:00.000Z');
    expect(next.status).toBe('completed');
    expect(next.completedAt).toBe('2026-08-16T08:27:09.326Z');
  });

  it('trusts the account stamp even when its status disagrees', () => {
    // The production row for the test account: `completed_at` set, status
    // dragged back to `in_progress` one second later.
    const next = reconcileInstallOnboardingState(local, {
      status: 'in_progress', goal: 'image', completedAt: '2026-08-28T06:50:51.761Z',
    }, '2026-08-28T07:00:00.000Z');
    expect(next.status).toBe('completed');
  });

  it('never un-finishes a local run from an unfinished account row', () => {
    // No code path PATCHes `skipped`, and the server serializes a missing row
    // as `not_started`, so an "earlier" server value carries no information.
    // Adopting it would resurrect the flow for everyone who ever skipped.
    const done = mergeInstallOnboardingState(defaultInstallOnboardingState, { status: 'completed' }, '2026-08-16T08:27:09.326Z');
    const next = reconcileInstallOnboardingState(done, {
      status: 'not_started', goal: null, completedAt: null,
    }, '2026-08-28T07:00:00.000Z');
    expect(next).toBe(done);
    expect(next.status).toBe('completed');
  });

  it('returns the same object when nothing changed', () => {
    // This runs on every app foreground; a fresh object each time would churn
    // AsyncStorage and re-render the navigator for no reason.
    const next = reconcileInstallOnboardingState(local, {
      status: 'not_started', goal: 'video', completedAt: null,
    }, '2026-08-28T07:00:00.000Z');
    expect(next).toBe(local);
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
