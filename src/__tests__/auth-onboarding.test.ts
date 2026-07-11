import { describe, expect, it } from 'vitest';

import {
  buildAuthCodeErrorPath,
  buildAuthContinuePath,
  buildProfileSetupPath,
  getPasswordRecoveryNextPath,
  getSafeAuthNextPath,
  hasSkippedProfileOnboarding,
  resolvePostAuthPath,
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
      '/profile?welcome=1&next=%2Fcreate%2Fvideo%3Fmodel%3Dkling%26recipe%3Dugc'
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
      '/profile?welcome=1&next=%2Fcreate'
    );
    expect(resolvePostAuthPath(null, '/create')).toBe(
      '/profile?welcome=1&next=%2Fcreate'
    );
    expect(resolvePostAuthPath({
      username: 'creator-a1b2c3d4',
      displayName: 'New creator',
    }, '/create/image')).toBe(
      '/profile?welcome=1&next=%2Fcreate%2Fimage'
    );
    expect(resolvePostAuthPath(
      null,
      '/profile?next=%2Fcreations'
    )).toBe('/profile?welcome=1&next=%2Fcreations');
  });

  it('returns ready profiles to the requested route', () => {
    expect(resolvePostAuthPath({
      username: 'athul-creates',
      displayName: 'Athul Creates',
    }, '/create/motion?source=showcase')).toBe('/create/motion?source=showcase');
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
