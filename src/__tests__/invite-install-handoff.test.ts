import { describe, expect, it } from 'vitest';

import { getSafeReferralDestination } from '@/lib/referral';

import {
  INVITE_INSTALL_REFERRER_SOURCE,
  buildInviteHandoffLink,
  buildInviteInstallReferrer,
  normalizeInviteHandoffPath,
  readInviteHandoffLink,
  readInviteInstallReferrer,
  withInviteInstallReferrer,
} from '../../ugc-mobile/lib/invite-share-link/invite-install-handoff';

const CODE = '30b5f916c7aa';
const PLAY = 'https://play.google.com/store/apps/details?id=com.magicbooklet.mobile';

// What the web writes for an install, the app must read back to the character
// (the cross-device plan, 2026-11-10): both halves live in one file.
describe('the invite Google Play carries through an install', () => {
  it('reads back what it wrote, for an invite link and for a shared link', () => {
    for (const handoff of [
      { code: CODE, kind: 'invite' as const, path: '/create' },
      { code: CODE, kind: 'shared_link' as const, path: '/showcase/8d4b1b9e-0c53-4c0e-9d2f-0d3a6f1c2b77' },
      { code: CODE, kind: 'shared_link' as const, path: '/creators/mira%20k' },
    ]) {
      expect(readInviteInstallReferrer(buildInviteInstallReferrer(handoff))).toEqual(handoff);
    }
  });

  it('keeps the utm names Play reports by, with a source of its own', () => {
    const referrer = buildInviteInstallReferrer({ code: CODE, kind: 'shared_link', path: '/creators/mira' });
    expect(referrer).toBe(`utm_source=${INVITE_INSTALL_REFERRER_SOURCE}&utm_medium=invite&utm_content=shared_link&mb_r=${CODE}&mb_p=%2Fcreators%2Fmira`);
  });

  it('puts it on the Play link as one encoded parameter, replacing any other', () => {
    const link = withInviteInstallReferrer(`${PLAY}&referrer=old#x`, { code: CODE, kind: 'invite', path: '/create' });
    expect(link.startsWith(`${PLAY}&referrer=`)).toBe(true);
    expect(link.split('referrer=')).toHaveLength(2);
    // As Play hands it to the app: decoded once.
    const carried = decodeURIComponent(link.slice(link.indexOf('referrer=') + 'referrer='.length));
    expect(readInviteInstallReferrer(carried)).toEqual({ code: CODE, kind: 'invite', path: '/create' });
  });

  it('leaves the Play link alone when there is no code to carry', () => {
    expect(withInviteInstallReferrer(PLAY, { code: 'nope', kind: 'invite', path: '/' })).toBe(PLAY);
    expect(buildInviteInstallReferrer({ code: '', kind: 'invite', path: '/' })).toBeNull();
  });

  // Play's answer for an install that carried nothing, seen on the emulator 2026-11-10.
  it.each([
    'utm_source=google-play&utm_medium=organic',
    `utm_source=google-play&utm_medium=organic&mb_r=${CODE}`,
    `utm_source=someone-else&mb_r=${CODE}`,
    `utm_source=${INVITE_INSTALL_REFERRER_SOURCE}&mb_r=NOT-A-CODE`,
    `utm_source=${INVITE_INSTALL_REFERRER_SOURCE}`,
    '',
    null,
    undefined,
    42,
    `utm_source=${INVITE_INSTALL_REFERRER_SOURCE}&mb_r=${CODE}&x=${'a'.repeat(2100)}`,
  ])('reads no invite from %j', (referrer) => {
    expect(readInviteInstallReferrer(referrer)).toBeNull();
  });

  it('falls back to the front page for a path that is not one of ours', () => {
    for (const path of ['https://evil.example/x', '//evil.example', '/a\\b', '/a?b=1', '/a#b', 'create', `/${'a'.repeat(600)}`, '/a\nb']) {
      expect(normalizeInviteHandoffPath(path)).toBe('/');
      const referrer = `utm_source=${INVITE_INSTALL_REFERRER_SOURCE}&mb_r=${CODE}&mb_p=${encodeURIComponent(path)}`;
      expect(readInviteInstallReferrer(referrer)).toEqual({ code: CODE, kind: 'shared_link', path: '/' });
    }
  });
});

describe('the invite link an iPhone copies and a laptop shows as a QR code', () => {
  it('is the invite landing for an invite link, with where it led', () => {
    expect(buildInviteHandoffLink('https://magicbooklet.com', { code: CODE, kind: 'invite', path: '/create' }))
      .toBe(`https://magicbooklet.com/r/${CODE}?next=%2Fcreate`);
    expect(buildInviteHandoffLink('https://magicbooklet.com/', { code: CODE, kind: 'invite', path: '/' }))
      .toBe(`https://magicbooklet.com/r/${CODE}`);
  });

  it('is the page with the invite back on it for a shared link', () => {
    expect(buildInviteHandoffLink('https://magicbooklet.com', { code: CODE, kind: 'shared_link', path: '/creators/mira' }))
      .toBe(`https://magicbooklet.com/creators/mira?r=${CODE}`);
  });

  it('reads back what it wrote', () => {
    for (const handoff of [
      { code: CODE, kind: 'invite' as const, path: '/create' },
      { code: CODE, kind: 'invite' as const, path: '/' },
      { code: CODE, kind: 'shared_link' as const, path: '/showcase/8d4b1b9e-0c53-4c0e-9d2f-0d3a6f1c2b77' },
      { code: CODE, kind: 'shared_link' as const, path: '/creators/mira%20k' },
    ]) {
      expect(readInviteHandoffLink(buildInviteHandoffLink('https://magicbooklet.com', handoff))).toEqual(handoff);
    }
  });

  it('reads a link as someone shared it, surface and fragment and all', () => {
    expect(readInviteHandoffLink(` https://www.magicbooklet.com/showcase/abc?s=feed&r=${CODE}#comments\n`))
      .toEqual({ code: CODE, kind: 'shared_link', path: '/showcase/abc' });
    expect(readInviteHandoffLink(`https://MAGICBOOKLET.com/r/${CODE.toUpperCase()}/`))
      .toEqual({ code: CODE, kind: 'invite', path: '/' });
  });

  // Whatever is on a clipboard: never another site's link, and never plain words.
  it.each([
    `https://evil.example/creators/mira?r=${CODE}`,
    `https://magicbooklet.com.evil.example/r/${CODE}`,
    `https://evil.example/?x=https://magicbooklet.com/r/${CODE}`,
    `http://magicbooklet.com/r/${CODE}`,
    `magicbooklet.com/r/${CODE}`,
    `Join me: https://magicbooklet.com/r/${CODE}`,
    'https://magicbooklet.com/r/nope',
    'https://magicbooklet.com/creators/mira',
    'https://magicbooklet.com/creators/mira?r=nope',
    CODE,
    '',
    null,
    undefined,
    `https://magicbooklet.com/r/${CODE}?next=${'a'.repeat(2100)}`,
  ])('reads no invite from %j', (text) => {
    expect(readInviteHandoffLink(text)).toBeNull();
  });

  it('accepts only the hosts it is given', () => {
    expect(readInviteHandoffLink(`https://localhost/r/${CODE}`)).toBeNull();
    expect(readInviteHandoffLink(`https://localhost/r/${CODE}`, ['localhost'])).toMatchObject({ code: CODE });
  });

  // The app sends the path back as the visit's destination: whatever the format lets
  // through, the server's own rule for a destination still decides.
  it('lets through no path the server would follow off the site', () => {
    for (const next of ['//evil.example', '/\\evil.example', 'https://evil.example']) {
      const read = readInviteHandoffLink(`https://magicbooklet.com/r/${CODE}?next=${encodeURIComponent(next)}`);
      expect(read).toEqual({ code: CODE, kind: 'invite', path: '/' });
      expect(getSafeReferralDestination(read!.path, '/create')).toMatch(/^\/(?!\/)/);
    }
  });
});
