import { describe, expect, it } from 'vitest';

import {
  buildAuthCodeErrorPath,
  buildAuthContinuePath,
  buildProfileSetupPath,
  getPasswordRecoveryNextPath,
  getSafeAuthNextPath,
  hasSkippedProfileOnboarding,
  creatorSignUpReturnPath,
  isCreatorPath,
  isCreatorSignUpReturn,
  resolvePostAuthPath,
  withCreatorWelcome,
  withoutCreatorReturnFlags,
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

  // A visitor signs up at a creator's Generate (owner, 2026-10-28): the creator asks
  // for the name and handle itself, in the card that adds the welcome credits. The
  // sheet marks its own way back (`handover`), so only that sign-in skips onboarding.
  it('sends a sign-up from a creator’s sheet straight back to it, flagged for its welcome card', () => {
    expect(resolvePostAuthPath(null, '/create-video?handover=nonce-1234')).toBe(
      '/create-video?handover=nonce-1234&welcome=1'
    );
    expect(resolvePostAuthPath({
      username: 'creator-a1b2c3d4',
      displayName: 'New creator',
    }, '/create-image?handover=nonce-1234')).toBe('/create-image?handover=nonce-1234&welcome=1');
    // A ready account comes back as it went, with nothing to greet.
    expect(resolvePostAuthPath({
      username: 'athul-creates',
      displayName: 'Athul Creates',
    }, '/create-video?handover=nonce-1234')).toBe('/create-video?handover=nonce-1234');
  });

  it('keeps the usual onboarding for a sign-in that only returns to a creator', () => {
    // A remix link's sign-in, or the top bar's Sign in on a creator.
    expect(resolvePostAuthPath(null, '/create-motion?remix=gen-1&remixPost=post-1')).toBe(
      '/profile?welcome=1&next=%2Fwelcome-reward%3Fnext%3D%252Fcreate-motion%253Fremix%253Dgen-1%2526remixPost%253Dpost-1'
    );
    expect(resolvePostAuthPath(null, '/create-workflow?handover=nonce-1234')).toBe(
      '/profile?welcome=1&next=%2Fwelcome-reward%3Fnext%3D%252Fcreate-workflow%253Fhandover%253Dnonce-1234'
    );
  });

  it('knows a sign-up return from a creator by its path and its hand-over mark', () => {
    expect(isCreatorPath('/create-image')).toBe(true);
    expect(isCreatorPath('/create-video?prompt=x')).toBe(true);
    expect(isCreatorPath('/create')).toBe(false);
    expect(isCreatorPath('/create-video/extra')).toBe(false);
    expect(isCreatorSignUpReturn('/create-video?handover=abc12345')).toBe(true);
    expect(isCreatorSignUpReturn('/create-video')).toBe(false);
    expect(isCreatorSignUpReturn('/create?handover=abc12345')).toBe(false);
    expect(withCreatorWelcome('/create-video?welcome=1&prompt=x')).toBe('/create-video?welcome=1&prompt=x');
  });

  it('builds the sheet’s way back: the visitor’s draft carries the link’s own settings', () => {
    const here = '/create-video?prompt=boat&model=kling-3.0-video&aspectRatio=9%3A16&duration=5&welcome=1&referral=applied&handover=old';
    expect(creatorSignUpReturnPath(here, 'nonce-1234')).toBe('/create-video?handover=nonce-1234');
    // An account's own page keeps its link, without an earlier return's flags.
    expect(creatorSignUpReturnPath(here, null)).toBe('/create-video?prompt=boat&model=kling-3.0-video&aspectRatio=9%3A16&duration=5');
    expect(withoutCreatorReturnFlags('/create-image?remix=g&welcome=1&referral=applied&handover=x#top')).toBe('/create-image?remix=g#top');
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
