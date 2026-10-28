import { describe, expect, it } from 'vitest';

import {
  buildAuthCodeErrorPath,
  buildAuthContinuePath,
  buildProfileSetupPath,
  getPasswordRecoveryNextPath,
  getSafeAuthNextPath,
  hasSkippedProfileOnboarding,
  isCreatorPath,
  resolvePostAuthPath,
  withCreatorWelcome,
} from '@/lib/auth-onboarding';
import {
  getPasswordRequirements,
  getPasswordValidationMessage,
  isPasswordValid,
} from '@/lib/password-policy';

describe('auth onboarding destinations', () => {
  it('preserves safe local creation intent through setup and continuation', () => {
    const next = '/create/video?model=kling&recipe=ugc';

    expect(buildProfileSetupPath(next)).toBe(
      '/profile?welcome=1&next=%2Fwelcome-reward%3Fnext%3D%252Fcreate%252Fvideo%253Fmodel%253Dkling%2526recipe%253Dugc'
    );
    expect(buildAuthContinuePath(next)).toBe(
      '/auth/continue?next=%2Fcreate%2Fvideo%3Fmodel%3Dkling%26recipe%3Dugc'
    );
    expect(buildAuthCodeErrorPath(next)).toBe(
      '/auth/auth-code-error?next=%2Fcreate%2Fvideo%3Fmodel%3Dkling%26recipe%3Dugc'
    );
  });

  it('rejects external, protocol-relative, and backslash redirect paths', () => {
    expect(getSafeAuthNextPath('https://attacker.example')).toBe('/create');
    expect(getSafeAuthNextPath('//attacker.example')).toBe('/create');
    expect(getSafeAuthNextPath('/\\attacker.example')).toBe('/create');
    expect(getSafeAuthNextPath('%2F%2Fattacker.example')).toBe('/create');
  });

  it('sends missing or incomplete profiles through setup with their intent intact', () => {
    expect(resolvePostAuthPath(null, null)).toBe(
      '/profile?welcome=1&next=%2Fwelcome-reward%3Fnext%3D%252Fcreate'
    );
    expect(resolvePostAuthPath(null, '/create')).toBe(
      '/profile?welcome=1&next=%2Fwelcome-reward%3Fnext%3D%252Fcreate'
    );
    expect(resolvePostAuthPath({
      username: 'creator-a1b2c3d4',
      displayName: 'New creator',
    }, '/create/image')).toBe(
      '/profile?welcome=1&next=%2Fwelcome-reward%3Fnext%3D%252Fcreate%252Fimage'
    );
    expect(resolvePostAuthPath(
      null,
      '/profile?next=%2Fcreations'
    )).toBe('/profile?welcome=1&next=%2Fwelcome-reward%3Fnext%3D%252Fcreations');
  });

  it('returns ready profiles to the requested route', () => {
    expect(resolvePostAuthPath({
      username: 'athul-creates',
      displayName: 'Athul Creates',
    }, '/create/motion?source=showcase')).toBe('/create/motion?source=showcase');
  });

  // A visitor signs up at a creator's Generate (owner, 2026-10-28): the creator
  // asks for the name and handle itself, in the card that adds the welcome credits.
  it('sends a sign-up from a creator straight back to it, flagged for its welcome card', () => {
    expect(resolvePostAuthPath(null, '/create-video?model=seedance-2-mini&prompt=boat')).toBe(
      '/create-video?model=seedance-2-mini&prompt=boat&welcome=1'
    );
    expect(resolvePostAuthPath({
      username: 'creator-a1b2c3d4',
      displayName: 'New creator',
    }, '/create-image')).toBe('/create-image?welcome=1');
    expect(resolvePostAuthPath(null, '/create-motion?remix=gen-1&remixPost=post-1')).toBe(
      '/create-motion?remix=gen-1&remixPost=post-1&welcome=1'
    );
    // A ready account comes back as it went, with nothing to greet.
    expect(resolvePostAuthPath({
      username: 'athul-creates',
      displayName: 'Athul Creates',
    }, '/create-video?prompt=boat')).toBe('/create-video?prompt=boat');
    // The launchpad and the workflow builder keep profile setup first.
    expect(resolvePostAuthPath(null, '/create-workflow')).toBe(
      '/profile?welcome=1&next=%2Fwelcome-reward%3Fnext%3D%252Fcreate-workflow'
    );
  });

  it('knows the three creators by their path alone', () => {
    expect(isCreatorPath('/create-image')).toBe(true);
    expect(isCreatorPath('/create-video?prompt=x')).toBe(true);
    expect(isCreatorPath('/create-motion#top')).toBe(true);
    expect(isCreatorPath('/create')).toBe(false);
    expect(isCreatorPath('/create-workflow')).toBe(false);
    expect(isCreatorPath('/create-video/extra')).toBe(false);
    expect(withCreatorWelcome('/create-video?welcome=1&prompt=x')).toBe('/create-video?welcome=1&prompt=x');
  });

  it('does not let profile setup intercept password recovery', () => {
    expect(resolvePostAuthPath(
      null,
      '/auth/reset-password?next=%2Fcreate'
    )).toBe('/auth/reset-password?next=%2Fcreate');
    expect(getPasswordRecoveryNextPath(
      '/auth/reset-password?next=%2Fcreate%2Fvideo%3Fmodel%3Dkling'
    )).toBe('/create/video?model=kling');
  });

  it('recognizes only the current persisted onboarding skip version', () => {
    expect(hasSkippedProfileOnboarding({
      creator_profile_onboarding_skipped_version: 1,
    })).toBe(true);
    expect(hasSkippedProfileOnboarding({
      creator_profile_onboarding_skipped_version: '1',
    })).toBe(false);
    expect(hasSkippedProfileOnboarding(null)).toBe(false);
  });
});

describe('auth password policy', () => {
  it('matches the configured lower, upper, number, symbol, and length policy', () => {
    const requirements = getPasswordRequirements('Strong-pass1!');

    expect(requirements.every((requirement) => requirement.isMet)).toBe(true);
    expect(isPasswordValid('Strong-pass1!')).toBe(true);
    expect(getPasswordValidationMessage('Strong-pass1!')).toBeNull();
  });

  it('reports every missing requirement for accessible inline guidance', () => {
    expect(isPasswordValid('lowercase')).toBe(false);
    expect(getPasswordValidationMessage('lowercase')).toMatch(
      /uppercase letter, one number, one symbol/i
    );
  });
});
