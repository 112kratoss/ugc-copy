import { describe, expect, it } from 'vitest';

import { normalizeReferralCode, normalizeTypedReferralCode } from '@/lib/referral';
import {
  INVITE_SHORT_CODE_ALPHABET,
  normalizeInviteShortCode,
  readTypedInviteCode,
  typedInviteSavedMessage,
} from '../../ugc-mobile/lib/invite-share-link/invite-typed-code';

const LINK_CODE = '30b5f916c7aa';

// Owner, 2026-11-11: an invite code a person can say. What either sign-up page
// sends for what was typed, and what the server accepts, must agree: a code one
// side takes and the other refuses is an invite that credits nobody.
describe('a typed invite code', () => {
  it.each([
    ['K7P2QX', 'K7P2QX'],
    [' k7p2qx ', 'K7P2QX'],
    ['k7p 2qx', 'K7P2QX'],
    ['K7P-2QX', 'K7P2QX'],
    [LINK_CODE, LINK_CODE],
    [LINK_CODE.toUpperCase(), LINK_CODE],
    [`https://magicbooklet.com/r/${LINK_CODE}`, LINK_CODE],
    [`https://www.magicbooklet.com/r/${LINK_CODE}?next=%2Fcreate`, LINK_CODE],
    [`magicbooklet.com/r/${LINK_CODE}`, LINK_CODE],
    [`https://magicbooklet.com/showcase/abc?s=feed&r=${LINK_CODE}`, LINK_CODE],
    ['https://magicbooklet.com/r/K7P2QX', 'K7P2QX'],
  ])('reads %j as %j', (typed, code) => {
    expect(readTypedInviteCode(typed)).toBe(code);
    // The server takes what the page sends.
    expect(normalizeTypedReferralCode(code)).toBe(code);
  });

  it.each([
    '',
    '   ',
    'K7P2Q',
    'K7P2QXX',
    'ABCDE0',
    'ABCDEI',
    'ABCDEO',
    'ABCDE1',
    'hello there',
    'https://evil.example/r/30b5f916c7aa',
    'https://magicbooklet.com.evil.example/r/30b5f916c7aa',
    'https://magicbooklet.com/showcase/abc',
    'https://magicbooklet.com/r/',
    'x'.repeat(3000),
    null,
    42,
  ])('refuses %j', (typed) => {
    expect(readTypedInviteCode(typed)).toBeNull();
  });

  it('reads the code out of a whole invite message pasted in (#766 review)', () => {
    const app = `Try Magicbooklet and get 5% bonus credits on your first top-up. Invite code: K7P2QX. Referral link — I may earn bonus credits if you top up.\nhttps://magicbooklet.com/r/${LINK_CODE}`;
    const web = `Create with me on Magic Booklet and get 5% bonus credits on your first top-up.\nInvite code: K7P2QX\n\nReferral link — I may earn bonus credits if you top up.\nhttps://magicbooklet.com/r/${LINK_CODE}`;
    const withoutCode = `Try Magicbooklet and get 5% bonus credits on your first top-up. Referral link — I may earn bonus credits if you top up.\nhttps://magicbooklet.com/r/${LINK_CODE}.`;
    expect(readTypedInviteCode(app)).toBe('K7P2QX');
    expect(readTypedInviteCode(web)).toBe('K7P2QX');
    expect(readTypedInviteCode(withoutCode)).toBe(LINK_CODE);
    expect(readTypedInviteCode('my code is K7P2QX ok')).toBeNull();
    expect(readTypedInviteCode('see https://evil.example/r/abc and https://magicbooklet.com/r/x')).toBeNull();
  });

  it('agrees with the server on what a short code is', () => {
    for (const value of ['K7P2QX', 'k7p2qx', 'ABCDE0', 'K7P2Q', LINK_CODE, ' K7P2QX ']) {
      expect(normalizeTypedReferralCode(value)).toBe(normalizeInviteShortCode(value) ?? normalizeReferralCode(value));
    }
  });

  it('uses every character of the alphabet and none that looks like another', () => {
    for (const character of INVITE_SHORT_CODE_ALPHABET) {
      expect(normalizeInviteShortCode(`${character}22222`)).toBe(`${character}22222`);
    }
    for (const character of '01IO') {
      expect(normalizeInviteShortCode(`${character}22222`)).toBeNull();
    }
  });

  it('says what a saved code gets, with the server\'s numbers or none', () => {
    expect(typedInviteSavedMessage(5)).toContain('5% bonus credits on your first top-up');
    expect(typedInviteSavedMessage(null)).toContain('get bonus credits on your first top-up');
    expect(typedInviteSavedMessage(5)).toContain('Whoever invited you may earn bonus credits if you join.');
  });
});
