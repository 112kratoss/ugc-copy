import { describe, expect, it } from 'vitest';

import { referralClaimStatus } from '@/lib/referral';
import { describeReferralClaim } from '@/lib/referral-claim-copy';

// What a sign-up is told about the invite it opened. A referral the abuse
// guard blocked used to be told "Invite applied: … gets the invite bonus",
// a bonus that was not on its way (review of 2026-11-10).
describe('what a new account is told about its invite', () => {
  it('says a held invite is held, an applied one applied, and a refusal why', () => {
    expect(referralClaimStatus({ claimed: true, clearCookie: true })).toBe('applied');
    expect(referralClaimStatus({ claimed: true, clearCookie: true, held: true })).toBe('held');
    expect(referralClaimStatus({ claimed: true, clearCookie: true, held: false })).toBe('applied');
    expect(referralClaimStatus({ claimed: false, clearCookie: true, reason: 'existing_account' })).toBe('existing_account');
    // Nothing concluded: the cookie is kept and nothing is said.
    expect(referralClaimStatus({ claimed: false, clearCookie: false, reason: 'profile_not_found' })).toBeNull();
  });

  it('promises no bonus to a held invite, and names no reason', () => {
    const held = describeReferralClaim('held');
    expect(held).toMatch(/^Invite received: /);
    expect(held).toContain('on hold');
    expect(held).not.toMatch(/gets the invite bonus|device|network/i);
    expect(describeReferralClaim('applied')).toContain('gets the invite bonus');
  });
});
