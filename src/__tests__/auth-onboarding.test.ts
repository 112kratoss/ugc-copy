import { describe, expect, it } from 'vitest';

import {
  buildAuthCodeErrorPath,
  buildAuthContinuePath,
  buildCreatorNameStepPath,
  creatorNameStepNextPath,
  getPasswordRecoveryNextPath,
  getSafeAuthNextPath,
  hasSkippedProfileOnboarding,
  creatorSignUpReturnPath,
  isCreatorPath,
  isCreatorSignUpReturn,
  isOldProfileSetupPath,
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
  it('preserves safe local creation intent through the name step and continuation', () => {
    const next = '/create/video?model=kling&recipe=ugc';

    expect(buildCreatorNameStepPath(next)).toBe(
      '/onboarding?next=%2Fcreate%2Fvideo%3Fmodel%3Dkling%26recipe%3Dugc'
    );
    expect(buildAuthContinuePath(next)).toBe(
      '/auth/continue?next=%2Fcreate%2Fvideo%3Fmodel%3Dkling%26recipe%3Dugc'
    );
    expect(buildAuthCodeErrorPath(next)).toBe(
      '/auth/auth-code-error?next=%2Fcreate%2Fvideo%3Fmodel%3Dkling%26recipe%3Dugc'
    );
  });

  it('rejects external, protocol-relative, and backslash redirect paths', () => {
    // The name step re-serialises its return through withCreatorWelcome: a next whose
    // dot segments resolve to //host must never come out protocol-relative.
    for (const offSite of ['/.//evil.example', '/..//evil.example', '/%2e//evil.example']) {
      const next = creatorNameStepNextPath(`/onboarding?next=${encodeURIComponent(offSite)}`);
      expect(withCreatorWelcome(next).startsWith('//')).toBe(false);
      expect(withCreatorWelcome(getSafeAuthNextPath(offSite))).toBe('/create?welcome=1');
    }
    expect(getSafeAuthNextPath('https://attacker.example')).toBe('/create');
    expect(getSafeAuthNextPath('//attacker.example')).toBe('/create');
    expect(getSafeAuthNextPath('/\\attacker.example')).toBe('/create');
    expect(getSafeAuthNextPath('%2F%2Fattacker.example')).toBe('/create');
    expect(buildCreatorNameStepPath('https://attacker.example')).toBe('/onboarding?next=%2Fcreate');
  });

  // Owner, 2026-11-09: the app's required creator name, on the web. No profile
  // setup and no welcome-reward hop: the step opens `next` with `welcome=1`.
  it('sends an account without a creator name to the name step, its intent intact', () => {
    expect(resolvePostAuthPath(null, null)).toBe('/onboarding?next=%2Fcreate');
    expect(resolvePostAuthPath(null, '/create')).toBe('/onboarding?next=%2Fcreate');
    expect(resolvePostAuthPath({
      username: 'creator-a1b2c3d4',
      displayName: 'New creator',
    }, '/create/image')).toBe('/onboarding?next=%2Fcreate%2Fimage');
    // A handle without a name is not a creator name yet either.
    expect(resolvePostAuthPath({ username: 'maya-k', displayName: '  ' }, '/showcase')).toBe(
      '/onboarding?next=%2Fshowcase'
    );
    expect(resolvePostAuthPath(null, '/profile?next=%2Fcreations')).toBe(
      '/onboarding?next=%2Fprofile%3Fnext%3D%252Fcreations'
    );
  });

  it('never wraps the name step, or an old first-profile link, inside the name step', () => {
    const oldLink = '/profile?welcome=1&next=%2Fwelcome-reward%3Fnext%3D%252Fcreate%252Fimage';
    expect(isOldProfileSetupPath(oldLink)).toBe(true);
    // The profile opened back from the name step is not an old link.
    expect(isOldProfileSetupPath('/profile?welcome=1')).toBe(false);
    expect(isOldProfileSetupPath('/profile?next=%2Fcreate')).toBe(false);
    expect(creatorNameStepNextPath(oldLink)).toBe('/create/image');
    expect(creatorNameStepNextPath('/onboarding?next=%2Fcreations')).toBe('/creations');
    expect(creatorNameStepNextPath('/onboarding')).toBe('/create');
    expect(creatorNameStepNextPath('/onboarding?next=%2Fonboarding%3Fnext%3D%252Fhome')).toBe('/home');
    // The welcome-reward page on its own is a page like any other until it goes.
    expect(creatorNameStepNextPath('/welcome-reward?next=%2Fcreate')).toBe('/welcome-reward?next=%2Fcreate');
    expect(resolvePostAuthPath(null, oldLink)).toBe('/onboarding?next=%2Fcreate%2Fimage');
    expect(resolvePostAuthPath(null, '/onboarding?next=%2Fcreations')).toBe('/onboarding?next=%2Fcreations');
  });

  it('returns ready profiles to the requested route', () => {
    const ready = { username: 'athul-creates', displayName: 'Athul Creates' };
    expect(resolvePostAuthPath(ready, '/create/motion?source=showcase')).toBe('/create/motion?source=showcase');
    // Straight past a setup step it had been sent to before signing in.
    expect(resolvePostAuthPath(ready, '/onboarding?next=%2Fcreations')).toBe('/creations');
    expect(resolvePostAuthPath(ready, '/profile?welcome=1&next=%2Fwelcome-reward%3Fnext%3D%252Fcreate')).toBe('/create');
  });

  // A visitor signs up at a creator's Generate (owner, 2026-10-28). The creator
  // name comes first now (owner, 2026-11-09), and the step comes back to the
  // creator with the sheet's hand-over nonce and the welcome flag.
  it('takes a sign-up from a creator’s sheet through the name step and back to it', () => {
    const fromSheet = '/create-video?handover=nonce-1234';
    expect(resolvePostAuthPath(null, fromSheet)).toBe('/onboarding?next=%2Fcreate-video%3Fhandover%3Dnonce-1234');
    expect(resolvePostAuthPath({
      username: 'creator-a1b2c3d4',
      displayName: 'New creator',
    }, '/create-image?handover=nonce-1234')).toBe('/onboarding?next=%2Fcreate-image%3Fhandover%3Dnonce-1234');
    // Where the step opens once the name is saved.
    expect(withCreatorWelcome(creatorNameStepNextPath('/create-video?handover=nonce-1234'))).toBe(
      '/create-video?handover=nonce-1234&welcome=1'
    );
    // A ready account comes back as it went, with nothing to greet.
    expect(resolvePostAuthPath({
      username: 'athul-creates',
      displayName: 'Athul Creates',
    }, fromSheet)).toBe(fromSheet);
  });

  it('honours a "Set up later" from before the name was required', () => {
    expect(resolvePostAuthPath(null, '/create', { identityDeferred: true })).toBe('/create');
    expect(resolvePostAuthPath(null, '/onboarding?next=%2Fcreations', { identityDeferred: true })).toBe('/creations');
    // A creator's sign-up return still greets it (its card asks for the name).
    expect(resolvePostAuthPath(null, '/create-video?handover=nonce-1234', { identityDeferred: true })).toBe(
      '/create-video?handover=nonce-1234&welcome=1'
    );
  });

  it('takes a sign-in that only returns to a creator through the name step too', () => {
    // A remix link's sign-in, or the top bar's Sign in on a creator.
    expect(resolvePostAuthPath(null, '/create-motion?remix=gen-1&remixPost=post-1')).toBe(
      '/onboarding?next=%2Fcreate-motion%3Fremix%3Dgen-1%26remixPost%3Dpost-1'
    );
    expect(resolvePostAuthPath(null, '/create-workflow?handover=nonce-1234')).toBe(
      '/onboarding?next=%2Fcreate-workflow%3Fhandover%3Dnonce-1234'
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

  it('does not let the name step intercept password recovery', () => {
    expect(resolvePostAuthPath(
      null,
      '/auth/reset-password?next=%2Fcreate'
    )).toBe('/auth/reset-password?next=%2Fcreate');
    expect(resolvePostAuthPath(null, '/auth/reset-password?next=%2Fcreate', { identityDeferred: true })).toBe(
      '/auth/reset-password?next=%2Fcreate'
    );
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
