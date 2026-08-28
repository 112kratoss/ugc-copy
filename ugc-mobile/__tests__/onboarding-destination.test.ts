import { describe, expect, it } from 'vitest';

import {
  isOnboardingActionable,
  resolveOnboardingDestination,
} from '../lib/onboarding-destination';

const noDeferral = { identityDeferredAt: null };

describe('resolving the onboarding destination', () => {
  it('sends a signed-out visitor to the intro', () => {
    expect(resolveOnboardingDestination({
      hasUser: false, welcome: null, local: noDeferral,
    })).toBe('intro');
  });

  it('waits rather than guessing while the account state is unknown', () => {
    // A missing welcome response means offline or a 500, not "nothing to do".
    // Answering `none` here is what made the card flicker in after the feed had
    // already laid out, shifting rows under a thumb.
    expect(resolveOnboardingDestination({
      hasUser: true, welcome: null, local: noDeferral,
    })).toBe('pending');
  });

  it('asks for a handle before anything else', () => {
    expect(resolveOnboardingDestination({
      hasUser: true,
      welcome: { status: 'not_eligible', identityComplete: false },
      local: noDeferral,
    })).toBe('identity');
  });

  it('still asks for a handle from an account that can never claim the pack', () => {
    // Most accounts predating the grant program are also the ones still on a
    // generated `creator-xxxxxxxx` handle. Hiding the card from every legacy
    // account would silence the one prompt that is actually actionable.
    expect(resolveOnboardingDestination({
      hasUser: true,
      welcome: { status: 'legacy_ineligible', identityComplete: false },
      local: noDeferral,
    })).toBe('identity');
  });

  it('honours "choose a name later"', () => {
    expect(resolveOnboardingDestination({
      hasUser: true,
      welcome: { status: 'not_eligible', identityComplete: false },
      local: { identityDeferredAt: '2026-08-28T07:00:00.000Z' },
    })).toBe('none');
  });

  it('offers the pack only while it is claimable', () => {
    expect(resolveOnboardingDestination({
      hasUser: true,
      welcome: { status: 'eligible', identityComplete: true },
      local: noDeferral,
    })).toBe('reward');
  });

  it('has nothing to offer an account that finished and cannot claim', () => {
    // The iOS symptom: 26,831 credits, identity claimed, permanently
    // ineligible — and yet routed to a screen headlined "25 creation credits".
    for (const status of ['legacy_ineligible', 'already_claimed', 'claimed', 'unavailable', 'not_eligible'] as const) {
      expect(resolveOnboardingDestination({
        hasUser: true,
        welcome: { status, identityComplete: true },
        local: noDeferral,
      })).toBe('none');
    }
  });
});

describe('whether an entry point should render', () => {
  it('shows only for destinations a tap can act on', () => {
    expect(isOnboardingActionable('intro')).toBe(true);
    expect(isOnboardingActionable('identity')).toBe(true);
    expect(isOnboardingActionable('reward')).toBe(true);
  });

  it('stays hidden when there is nothing to do or nothing known yet', () => {
    expect(isOnboardingActionable('none')).toBe(false);
    expect(isOnboardingActionable('pending')).toBe(false);
  });
});
