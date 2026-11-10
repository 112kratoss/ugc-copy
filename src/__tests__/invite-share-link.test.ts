import { describe, expect, it } from 'vitest';

import { normalizeReferralCode } from '@/lib/referral';
import {
  INVITE_SHARE_QUERY_PARAM,
  normalizeInviteShareCode,
  readInviteShareCode,
  withInviteShareCode,
  withoutInviteShareCode,
} from '../../ugc-mobile/lib/invite-share-link/invite-share-link';

const CODE = '30b5f916c7aa';

describe('the invite a shared link carries', () => {
  // The app and the web build these links and the web's server reads the code
  // out of them: a code one side accepts and the other refuses is an invite
  // that silently credits nobody.
  it.each([
    CODE,
    ' 30B5F916C7AA ',
    'abcdefgh',
    'a'.repeat(24),
    'abcdefg',
    'a'.repeat(25),
    'has-dash-12',
    'with space',
    '',
    'ünïcödé123',
  ])('agrees with the server on whether %j is a code', (value) => {
    expect(normalizeInviteShareCode(value)).toBe(normalizeReferralCode(value));
  });

  it.each([undefined, null, 42, {}, [CODE]])('takes %j for no code', (value) => {
    expect(normalizeInviteShareCode(value)).toBeNull();
  });

  it('rides in the parameter the landings read', () => {
    expect(INVITE_SHARE_QUERY_PARAM).toBe('r');
  });

  it.each([
    ['https://magicbooklet.com/showcase/p1?s=feed', `https://magicbooklet.com/showcase/p1?s=feed&r=${CODE}`],
    ['https://magicbooklet.com/creators/athul', `https://magicbooklet.com/creators/athul?r=${CODE}`],
    ['/showcase/p1?s=showcase-reel#recipe', `/showcase/p1?s=showcase-reel&r=${CODE}#recipe`],
    ['/showcase/p1#recipe', `/showcase/p1?r=${CODE}#recipe`],
    ['https://magicbooklet.com/showcase/p1?', `https://magicbooklet.com/showcase/p1?r=${CODE}`],
  ])('adds the sharer’s code to %s and leaves the rest alone', (link, shared) => {
    expect(withInviteShareCode(link, CODE)).toBe(shared);
  });

  it('replaces an invite the link already carried: a link is its own sharer’s', () => {
    expect(withInviteShareCode(`/showcase/p1?r=aaaaaaaaaaaa&s=feed`, CODE)).toBe(`/showcase/p1?s=feed&r=${CODE}`);
    expect(withInviteShareCode(`/showcase/p1?s=feed&r=${CODE}`, CODE)).toBe(`/showcase/p1?s=feed&r=${CODE}`);
  });

  it.each([null, undefined, '', 'not a code'])('sends a link out with no invite when the sharer has none (%j)', (code) => {
    expect(withInviteShareCode('https://magicbooklet.com/showcase/p1?s=feed', code))
      .toBe('https://magicbooklet.com/showcase/p1?s=feed');
    // And takes off one it arrived with, so a guest does not pass on someone else's.
    expect(withInviteShareCode(`/showcase/p1?s=feed&r=${CODE}`, code)).toBe('/showcase/p1?s=feed');
  });

  it('leaves a parameter that only starts like it alone', () => {
    expect(withInviteShareCode('/showcase/p1?returnTo=%2Fhome&ref=x', CODE))
      .toBe(`/showcase/p1?returnTo=%2Fhome&ref=x&r=${CODE}`);
    expect(withoutInviteShareCode(`/showcase/p1?ref=x&r=${CODE}`)).toBe('/showcase/p1?ref=x');
  });

  it('reads the code a landing was opened with', () => {
    expect(readInviteShareCode(`?s=feed&r=${CODE}`)).toBe(CODE);
    expect(readInviteShareCode(`s=feed&r=${CODE}`)).toBe(CODE);
    expect(readInviteShareCode(`?r=${CODE.toUpperCase()}`)).toBe(CODE);
    // What a link built here says, a landing reads back.
    expect(readInviteShareCode(withInviteShareCode('/showcase/p1?s=feed', CODE).split('?')[1])).toBe(CODE);
  });

  it.each([
    null,
    undefined,
    '',
    '?s=feed',
    '?r=',
    '?r=short',
    '?r=%E0%A4%A',
    '?ref=30b5f916c7aa',
    '?returnTo=%2Fshowcase%2Fp1%3Fr%3D30b5f916c7aa',
  ])('reads no invite from %j', (search) => {
    expect(readInviteShareCode(search)).toBeNull();
  });
});
