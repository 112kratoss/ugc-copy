import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CREATOR_SETUP_CHECK_TIMEOUT_MS,
  CREATOR_SETUP_HANDOFF_MAX_AGE_MS,
  clearCreatorSetupAnswers,
  creatorSetupHasStep,
  handOffCreatorSetupAnswers,
  peekCreatorSetupAnswers,
  readCreatorSetupAnswers,
  type CreatorSetupAnswers,
} from '../lib/creator-setup-answers';
import type { ProfileResponse, WelcomeCreditResponse } from '../lib/types';

const profile = {
  id: 'user-1', username: 'maker', displayName: 'Maker', bio: null, avatarUrl: null, coverUrl: null,
  websiteUrl: null, twitterHandle: null, instagramHandle: null, tiktokHandle: null, location: null, credits: 25,
} as ProfileResponse;

function welcome(over: Partial<WelcomeCreditResponse> = {}): WelcomeCreditResponse {
  return {
    programKey: 'welcome-v1', status: 'claimed', amount: 25, promotionalAmount: 25, credits: 25,
    promotionalCredits: 0, claimedAt: null, identityComplete: true, ...over,
  };
}

const freshInstall = { identityDeferredAt: null, identityDeferredFor: null, status: 'not_started' as const };

describe('readCreatorSetupAnswers', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads the profile and the welcome answer together', async () => {
    const api = { getProfile: vi.fn(async () => profile), getWelcomeCredits: vi.fn(async () => welcome()) };
    await expect(readCreatorSetupAnswers(api)).resolves.toEqual({ profile, welcome: welcome() });
    expect(api.getProfile).toHaveBeenCalledTimes(1);
    expect(api.getWelcomeCredits).toHaveBeenCalledTimes(1);
  });

  it('answers nothing when either read fails, or throws as it is made', async () => {
    await expect(readCreatorSetupAnswers({
      getProfile: async () => profile,
      getWelcomeCredits: async () => { throw new Error('offline'); },
    })).resolves.toBeNull();
    await expect(readCreatorSetupAnswers({
      getProfile: () => { throw new TypeError('not a function'); },
      getWelcomeCredits: async () => welcome(),
    })).resolves.toBeNull();
  });

  it('stops waiting at the timeout, so a slow answer never holds the sign-in page', async () => {
    vi.useFakeTimers();
    const read = readCreatorSetupAnswers({
      getProfile: async () => profile,
      getWelcomeCredits: () => new Promise<WelcomeCreditResponse>(() => undefined),
    });
    await vi.advanceTimersByTimeAsync(CREATOR_SETUP_CHECK_TIMEOUT_MS - 1);
    let settled = false;
    void read.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(read).resolves.toBeNull();
  });
});

describe('creatorSetupHasStep', () => {
  const answers = (over: Partial<WelcomeCreditResponse>): CreatorSetupAnswers => ({ profile, welcome: welcome(over) });

  it('has the name step for an account without a creator name', () => {
    expect(creatorSetupHasStep(answers({ identityComplete: false, status: 'not_eligible' }), { local: freshInstall, accountMetadata: {} })).toBe(true);
  });

  it('has nothing for an account set up, with or without credits still to claim (the popup offers those)', () => {
    for (const status of ['claimed', 'already_claimed', 'eligible', 'legacy_ineligible', 'unavailable'] as const) {
      expect(creatorSetupHasStep(answers({ status }), { local: freshInstall, accountMetadata: {} })).toBe(false);
    }
  });

  it('honours "Set up later" on this install for this account, and on the account from anywhere', () => {
    const unnamed = answers({ identityComplete: false, status: 'not_eligible' });
    const deferredHere = { ...freshInstall, identityDeferredAt: '2026-11-01T00:00:00.000Z', identityDeferredFor: 'user-1' };
    expect(creatorSetupHasStep(unnamed, { local: deferredHere, accountMetadata: {} })).toBe(false);
    // Another account's deferral on this phone is not this one's.
    expect(creatorSetupHasStep(unnamed, { local: { ...deferredHere, identityDeferredFor: 'user-2' }, accountMetadata: {} })).toBe(true);
    expect(creatorSetupHasStep(unnamed, {
      local: freshInstall,
      accountMetadata: { creator_profile_onboarding_skipped_version: 1 },
    })).toBe(false);
    // Unknown account metadata defers nothing.
    expect(creatorSetupHasStep(unnamed, { local: freshInstall, accountMetadata: undefined })).toBe(true);
  });
});

describe('the hand-off to onboarding', () => {
  const answers: CreatorSetupAnswers = { profile, welcome: welcome({ identityComplete: false, status: 'not_eligible' }) };

  beforeEach(() => {
    clearCreatorSetupAnswers();
  });

  it('is read by the account it describes while fresh, as often as the screen is built', () => {
    handOffCreatorSetupAnswers(answers, 1_000);
    expect(peekCreatorSetupAnswers('user-1', 1_000)).toEqual(answers);
    expect(peekCreatorSetupAnswers('user-1', 1_000 + CREATOR_SETUP_HANDOFF_MAX_AGE_MS)).toEqual(answers);
    expect(peekCreatorSetupAnswers('user-1', 1_500)).toEqual(answers);
  });

  it('is nobody else’s, goes stale, never comes from the future, and is gone once cleared', () => {
    handOffCreatorSetupAnswers(answers, 1_000);
    expect(peekCreatorSetupAnswers('user-2', 1_000)).toBeNull();
    expect(peekCreatorSetupAnswers('user-1', 1_001 + CREATOR_SETUP_HANDOFF_MAX_AGE_MS)).toBeNull();
    expect(peekCreatorSetupAnswers('user-1', 999)).toBeNull();
    clearCreatorSetupAnswers();
    expect(peekCreatorSetupAnswers('user-1', 1_000)).toBeNull();
  });
});
