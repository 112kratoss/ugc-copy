import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));

import {
  INVITE_SHARE_QUERY_PARAM,
  normalizeInviteShareCode,
  readInviteShareCode,
  withInviteShareCode,
  withoutInviteShareCode,
} from '../lib/invite-share-link/invite-share-link';
import { normalizeReferralCode } from '../lib/referral-attribution';
import { buildShareUrl } from '../lib/viewer-actions';

const CODE = '30b5f916c7aa';

// The module is the web's too, and `src/__tests__/invite-share-link.test.ts`
// holds it to the server's rule for a code. These hold the app's two ends of
// it together: the link the app sends out is one the app can read back.
describe('the invite a shared link carries, in the app', () => {
  it('reads back the invite from a link the app built', () => {
    const url = buildShareUrl('https://magicbooklet.com', '/showcase/post-1', 'showcase-reel', CODE);
    const query = url.slice(url.indexOf('?'));

    expect(query).toBe(`?s=showcase-reel&${INVITE_SHARE_QUERY_PARAM}=${CODE}`);
    expect(readInviteShareCode(query)).toBe(CODE);
    // expo-router hands the page the parameter already split out
    // (`inviteShareParam` in `lib/use-invite-share-capture.ts` reads it so).
    expect(normalizeInviteShareCode(new URLSearchParams(query).get(INVITE_SHARE_QUERY_PARAM))).toBe(CODE);
  });

  it('accepts no code the invite capture would refuse', () => {
    for (const value of [CODE, 'abcdefgh', 'a'.repeat(24), ' 30B5F916C7AA ']) {
      const code = normalizeInviteShareCode(value);
      expect(code).not.toBeNull();
      // `capturePendingReferral` throws on a code this rule turns away.
      expect(normalizeReferralCode(code)).toBe(code);
    }
    for (const value of ['abcdefg', 'a'.repeat(25), 'has-dash-12', 'with space', '', undefined, null, 42]) {
      expect(normalizeInviteShareCode(value)).toBeNull();
    }
  });

  it("puts the sharer's invite on a link once, whatever it carried", () => {
    expect(withInviteShareCode('https://magicbooklet.com/showcase/post-1?s=feed&r=aaaaaaaa1111', CODE))
      .toBe(`https://magicbooklet.com/showcase/post-1?s=feed&r=${CODE}`);
    expect(withInviteShareCode('https://magicbooklet.com/creators/luna', CODE))
      .toBe(`https://magicbooklet.com/creators/luna?r=${CODE}`);
    expect(withInviteShareCode('https://magicbooklet.com/showcase/post-1?s=feed#comments', CODE))
      .toBe(`https://magicbooklet.com/showcase/post-1?s=feed&r=${CODE}#comments`);
    expect(withoutInviteShareCode(`https://magicbooklet.com/showcase/post-1?s=feed&r=${CODE}`))
      .toBe('https://magicbooklet.com/showcase/post-1?s=feed');
  });
});
