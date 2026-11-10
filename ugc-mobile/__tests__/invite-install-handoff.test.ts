import { describe, expect, it } from 'vitest';

import {
  buildInviteHandoffLink,
  buildInviteInstallReferrer,
  readInviteHandoffLink,
  readInviteInstallReferrer,
} from '../lib/invite-share-link/invite-install-handoff';

const CODE = '30b5f916c7aa';

// The module is the web's too (`src/__tests__/invite-install-handoff.test.ts`
// holds its rules). These spell out, to the character, what the web's pages
// write today, so a change of format fails here until the app reads the new
// one: the app in someone's hands is what reads it, at its first launch.
describe('an invite handed to the app at install', () => {
  it('reads the referrer the web puts on the Play link', () => {
    expect(readInviteInstallReferrer(
      `utm_source=magicbooklet-invite&utm_medium=invite&utm_content=shared_link&mb_r=${CODE}&mb_p=%2Fcreators%2Fmira`,
    )).toEqual({ code: CODE, kind: 'shared_link', path: '/creators/mira' });
    expect(readInviteInstallReferrer(
      `utm_source=magicbooklet-invite&utm_medium=invite&utm_content=invite&mb_r=${CODE}&mb_p=%2Fcreate`,
    )).toEqual({ code: CODE, kind: 'invite', path: '/create' });
  });

  it('reads no invite from Play’s answer for an install that carried none', () => {
    expect(readInviteInstallReferrer('utm_source=google-play&utm_medium=organic')).toBeNull();
  });

  it('reads the links the web copies for an iPhone', () => {
    expect(readInviteHandoffLink(`https://magicbooklet.com/r/${CODE}?next=%2Fcreate`))
      .toEqual({ code: CODE, kind: 'invite', path: '/create' });
    expect(readInviteHandoffLink(`https://magicbooklet.com/creators/mira?r=${CODE}`))
      .toEqual({ code: CODE, kind: 'shared_link', path: '/creators/mira' });
  });

  it('writes those same strings', () => {
    expect(buildInviteInstallReferrer({ code: CODE, kind: 'shared_link', path: '/creators/mira' }))
      .toBe(`utm_source=magicbooklet-invite&utm_medium=invite&utm_content=shared_link&mb_r=${CODE}&mb_p=%2Fcreators%2Fmira`);
    expect(buildInviteHandoffLink('https://magicbooklet.com', { code: CODE, kind: 'invite', path: '/create' }))
      .toBe(`https://magicbooklet.com/r/${CODE}?next=%2Fcreate`);
  });

  it('takes nothing but a link to this site for an invite', () => {
    expect(readInviteHandoffLink(`https://evil.example/r/${CODE}`)).toBeNull();
    expect(readInviteHandoffLink(`my code is ${CODE}`)).toBeNull();
  });
});
