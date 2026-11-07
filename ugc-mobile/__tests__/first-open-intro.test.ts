import { describe, expect, it } from 'vitest';

import { decideFirstOpenIntro, type FirstOpenIntroInput } from '../lib/first-open-intro';

const newInstall: FirstOpenIntroInput = {
  seen: false,
  onboardingHydrated: true,
  storageAvailable: true,
  authLoading: false,
  hasUser: false,
  onboardingStatus: 'not_started',
};

describe('decideFirstOpenIntro', () => {
  it('plays for a new install: nothing stored, nobody signed in, onboarding never started', () => {
    expect(decideFirstOpenIntro(newInstall)).toBe('show');
  });

  it('waits while the flag, the onboarding store or the session is still loading', () => {
    expect(decideFirstOpenIntro({ ...newInstall, seen: null })).toBe('unknown');
    expect(decideFirstOpenIntro({ ...newInstall, onboardingHydrated: false })).toBe('unknown');
    expect(decideFirstOpenIntro({ ...newInstall, authLoading: true })).toBe('unknown');
  });

  it('plays once: never again after it has been seen', () => {
    expect(decideFirstOpenIntro({ ...newInstall, seen: true })).toBe('skip');
  });

  it('never plays for someone who already has the app, including after the update that brings it', () => {
    expect(decideFirstOpenIntro({ ...newInstall, hasUser: true })).toBe('skip');
    expect(decideFirstOpenIntro({ ...newInstall, onboardingStatus: 'skipped' })).toBe('skip');
    expect(decideFirstOpenIntro({ ...newInstall, onboardingStatus: 'in_progress' })).toBe('skip');
    expect(decideFirstOpenIntro({ ...newInstall, onboardingStatus: 'completed' })).toBe('skip');
  });

  it('does not play when the store cannot be written, or it would play at every launch', () => {
    expect(decideFirstOpenIntro({ ...newInstall, storageAvailable: false })).toBe('skip');
  });
});
