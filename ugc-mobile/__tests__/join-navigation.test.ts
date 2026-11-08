import { describe, expect, it, vi } from 'vitest';

import { JOIN_ROUTE, onboardingReturnTo, openSignUpSheet, providerSignInHref, signUpNeededToCreate } from '../lib/join-navigation';

describe('signUpNeededToCreate', () => {
  it('asks anyone without an account and without credits (owner, 2026-11-08)', () => {
    expect(signUpNeededToCreate({ hasUser: false, credits: 0 })).toBe(true);
    // Not loaded yet counts as nothing to spend.
    expect(signUpNeededToCreate({ hasUser: false, credits: null })).toBe(true);
  });

  it('lets a guest who holds credits keep creating with them, and never asks an account', () => {
    expect(signUpNeededToCreate({ hasUser: false, credits: 40 })).toBe(false);
    expect(signUpNeededToCreate({ hasUser: true, credits: 0 })).toBe(false);
    expect(signUpNeededToCreate({ hasUser: true, credits: null })).toBe(false);
  });
});

describe('openSignUpSheet', () => {
  it('opens the sheet with where to come back to', () => {
    const router = { push: vi.fn() };
    openSignUpSheet(router, '/post/post-1');
    expect(router.push).toHaveBeenCalledWith({ pathname: JOIN_ROUTE, params: { returnTo: '/post/post-1' } });
  });

  it('opens it bare for a return that is missing or not one of the app\'s own paths', () => {
    const router = { push: vi.fn() };
    openSignUpSheet(router, undefined);
    openSignUpSheet(router, 'https://example.com');
    openSignUpSheet(router, '//evil.example');
    expect(router.push.mock.calls).toEqual([[JOIN_ROUTE], [JOIN_ROUTE], [JOIN_ROUTE]]);
  });
});

describe('onboardingReturnTo', () => {
  it("keeps the app's own paths, with their params, and drops anything else", () => {
    expect(onboardingReturnTo('/create/image?remix=gen-1&prompt=A+b')).toBe('/create/image?remix=gen-1&prompt=A+b');
    expect(onboardingReturnTo(['/post/post-1'])).toBe('/post/post-1');
    expect(onboardingReturnTo(undefined)).toBeNull();
    expect(onboardingReturnTo('https://example.com')).toBeNull();
  });
});

describe('providerSignInHref (Apple or Google on the email form)', () => {
  it('goes on through the name and the welcome credits, then the return', () => {
    expect(providerSignInHref('/post/post-1')).toEqual({ pathname: '/onboarding', params: { returnTo: '/post/post-1' } });
    expect(providerSignInHref(undefined)).toEqual({ pathname: '/onboarding', params: { returnTo: '/(tabs)' } });
  });

  it('uses a return that is onboarding already as it is, never wrapping it twice', () => {
    expect(providerSignInHref('/onboarding?returnTo=%2Fpost%2Fpost-1')).toBe('/onboarding?returnTo=%2Fpost%2Fpost-1');
    expect(providerSignInHref('/onboarding')).toBe('/onboarding');
  });
});
