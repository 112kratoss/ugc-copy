import { describe, expect, it } from 'vitest';

import {
  hasClaimedCreatorIdentity,
  isOnboardingEventName,
  isOnboardingGoal,
  isValidOnboardingClientEventId,
  isValidOnboardingInstallationId,
} from '@/lib/onboarding';

describe('onboarding contracts', () => {
  it('requires a custom handle and display name for welcome-credit eligibility', () => {
    expect(hasClaimedCreatorIdentity({ username: 'creator-deadbeef', display_name: 'Athul' })).toBe(false);
    expect(hasClaimedCreatorIdentity({ username: 'athul-studio', display_name: 'Athul' })).toBe(true);
    expect(hasClaimedCreatorIdentity({ username: 'athul-studio', display_name: ' ' })).toBe(false);
  });

  it('accepts only the fixed analytics vocabulary and pseudonymous IDs', () => {
    expect(isOnboardingGoal('motion')).toBe(true);
    expect(isOnboardingGoal('workflow')).toBe(false);
    expect(isOnboardingEventName('reward_claimed')).toBe(true);
    expect(isOnboardingEventName('prompt_entered')).toBe(false);
    expect(isValidOnboardingInstallationId(`fid_${'a'.repeat(64)}`)).toBe(true);
    expect(isValidOnboardingInstallationId('device-1')).toBe(false);
    expect(isValidOnboardingClientEventId('4b7d7d29-9ee7-4f5e-9cf0-c5df9f73dbe4')).toBe(true);
  });
});
