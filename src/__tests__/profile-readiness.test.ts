import { afterEach, describe, expect, it, vi } from 'vitest';

import reservedHandlesContract from '../../contracts/reserved-handles-v1.json';
import {
  getCreatorProfileReadiness,
  getReservedProfileUsernameError,
  getSafeProfileNextPath,
  isClaimedProfileUsername,
  isGeneratedProfileUsername,
  isReservedProfileUsername,
  validateProfileUpdate,
} from '@/lib/profile';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('creator profile readiness', () => {
  it('does not treat a generated signup handle as claimed identity', () => {
    expect(isGeneratedProfileUsername('creator-a1b2c3d4')).toBe(true);
    expect(isClaimedProfileUsername('creator-a1b2c3d4')).toBe(false);

    expect(getCreatorProfileReadiness({
      username: 'creator-a1b2c3d4',
      displayName: 'Athul',
      avatarUrl: 'https://example.com/avatar.png',
      bio: 'UGC creator',
    })).toMatchObject({
      hasClaimedHandle: false,
      publicPublishReady: false,
      sellerReady: false,
      profileComplete: false,
    });
  });

  it('reserves generated-looking handles instead of saving an unusable identity', () => {
    expect(validateProfileUpdate({ username: 'creator-deadbeef' }).fieldErrors.username)
      .toMatch(/reserved creator-xxxxxxxx/i);
    expect(validateProfileUpdate({ username: 'custom-creator' }).fieldErrors.username)
      .toBeUndefined();
  });

  it('keeps the stored display name when a save leaves it out, never clears it, and leaves the bio optional', () => {
    // Partial PATCH: a key left out keeps the stored value.
    const unnamed = validateProfileUpdate({ username: 'custom-creator' });
    expect(unnamed.fieldErrors).toEqual({});
    expect(unnamed.data.displayName).toBeUndefined();
    // Sent, the name is required: blank or null is refused rather than clearing it.
    expect(validateProfileUpdate({ username: 'custom-creator', displayName: '   ' }).fieldErrors.displayName)
      .toMatch(/display name/i);
    expect(validateProfileUpdate({ username: 'custom-creator', displayName: null }).fieldErrors.displayName)
      .toMatch(/display name/i);

    // A blank bio must stay saveable: most existing profiles have none, and an
    // unrelated edit cannot start demanding one.
    const named = validateProfileUpdate({ username: 'custom-creator', displayName: 'Custom Creator' });
    expect(named.fieldErrors.displayName).toBeUndefined();
    expect(named.fieldErrors.bio).toBeUndefined();
    expect(validateProfileUpdate({ username: 'custom-creator', displayName: 'Custom Creator', bio: '' }).fieldErrors)
      .toEqual({});
  });

  it('requires HTTPS profile media and app-controlled hosts in production', () => {
    expect(validateProfileUpdate({
      username: 'custom-creator',
      avatarUrl: 'http://magicbooklet.com/avatar.png',
    }).fieldErrors.avatarUrl).toMatch(/HTTPS avatar/i);

    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://magicbooklet.com');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co');

    expect(validateProfileUpdate({
      username: 'custom-creator',
      avatarUrl: 'https://tracker.example/avatar.png',
    }).fieldErrors.avatarUrl).toMatch(/Magicbooklet/i);
    expect(validateProfileUpdate({
      username: 'custom-creator',
      displayName: 'Custom Creator',
      avatarUrl: 'https://project.supabase.co/storage/v1/object/public/profiles/avatar.png',
      coverUrl: 'https://cdn.magicbooklet.com/cover.png',
    }).fieldErrors).toEqual({});
  });

  it('requires a claimed handle and display name for public publishing and for selling', () => {
    const readiness = getCreatorProfileReadiness({
      username: 'athul-creates',
      displayName: 'Athul Creates',
    });

    expect(readiness.publicPublishReady).toBe(true);
    // A photo is never required to sell: the seller tier is the public identity.
    expect(readiness.sellerReady).toBe(true);
    expect(readiness.missingForSeller).toEqual([]);

    expect(getCreatorProfileReadiness({ username: 'athul-creates' })).toMatchObject({
      sellerReady: false,
      missingForSeller: ['displayName'],
    });
  });

  it('counts the avatar and the bio only toward a complete profile, keeping cover optional', () => {
    expect(getCreatorProfileReadiness({
      username: 'athul-creates',
      displayName: 'Athul Creates',
    })).toMatchObject({ profileComplete: false, missingForCompleteProfile: ['avatar', 'bio'] });

    expect(getCreatorProfileReadiness({
      username: 'athul-creates',
      displayName: 'Athul Creates',
      bio: 'UGC creator',
    })).toMatchObject({ sellerReady: true, profileComplete: false, missingForCompleteProfile: ['avatar'] });

    const withAvatar = getCreatorProfileReadiness({
      username: 'athul-creates',
      displayName: 'Athul Creates',
      avatarUrl: 'https://example.com/avatar.png',
    });
    expect(withAvatar.sellerReady).toBe(true);
    expect(withAvatar.profileComplete).toBe(false);
    expect(withAvatar.missingForCompleteProfile).toEqual(['bio']);

    expect(getCreatorProfileReadiness({
      username: 'athul-creates',
      displayName: 'Athul Creates',
      avatarUrl: 'https://example.com/avatar.png',
      bio: 'UGC creator',
    }).profileComplete).toBe(true);
  });

  it('keeps only safe internal destinations for onboarding continuation', () => {
    expect(getSafeProfileNextPath('/create-image?model=gpt-image-2')).toBe(
      '/create-image?model=gpt-image-2'
    );
    expect(getSafeProfileNextPath('%2Fcreate-video%3Fmodel%3Dkling')).toBe(
      '/create-video?model=kling'
    );
    expect(getSafeProfileNextPath('/create-image?prompt=50%25+off')).toBe(
      '/create-image?prompt=50%25+off'
    );
    expect(getSafeProfileNextPath('//malicious.example')).toBe('/creations');
    expect(getSafeProfileNextPath('/\\malicious.example')).toBe('/creations');
    expect(getSafeProfileNextPath('/%5Cmalicious.example')).toBe('/creations');
    expect(getSafeProfileNextPath('https://malicious.example')).toBe('/creations');
  });
});

describe('profile update fields', () => {
  const save = (fields: Record<string, unknown>) => validateProfileUpdate({ username: 'custom-creator', ...fields });

  it('tells a field left out (keep the stored value) from one sent as null or blank (clear it)', () => {
    const { data, fieldErrors } = save({ bio: null, websiteUrl: '   ', location: ' Bengaluru ' });

    expect(fieldErrors).toEqual({});
    expect(data).toStrictEqual({
      username: 'custom-creator',
      displayName: undefined,
      bio: null,
      avatarUrl: undefined,
      coverUrl: undefined,
      websiteUrl: null,
      twitterHandle: undefined,
      instagramHandle: undefined,
      tiktokHandle: undefined,
      location: 'Bengaluru',
    });
  });

  it('stores the handle from a handle, an @handle or a profile link on the platform host', () => {
    for (const value of [
      'luna_dreams',
      '@luna_dreams',
      'https://x.com/luna_dreams',
      'https://www.x.com/luna_dreams/',
      'https://twitter.com/luna_dreams?s=21',
      'https://www.twitter.com/@luna_dreams',
      'x.com/luna_dreams',
    ]) {
      expect(save({ twitterHandle: value }), value).toMatchObject({
        fieldErrors: {},
        data: { twitterHandle: 'luna_dreams' },
      });
    }
    for (const value of [
      'luna.dreams',
      '@luna.dreams',
      'https://instagram.com/luna.dreams',
      'https://www.instagram.com/luna.dreams/',
      'instagram.com/luna.dreams?igsh=abc',
    ]) {
      expect(save({ instagramHandle: value }), value).toMatchObject({
        fieldErrors: {},
        data: { instagramHandle: 'luna.dreams' },
      });
    }
    for (const value of [
      'luna.dreams',
      '@luna.dreams',
      'https://www.tiktok.com/@luna.dreams',
      'https://tiktok.com/@luna.dreams/',
      'https://www.tiktok.com/@luna.dreams/video/7300000000000000000',
    ]) {
      expect(save({ tiktokHandle: value }), value).toMatchObject({
        fieldErrors: {},
        data: { tiktokHandle: 'luna.dreams' },
      });
    }
  });

  it('refuses a link to any other site and a handle the platform would not accept', () => {
    const x = 'Enter your X username or profile link.';
    const instagram = 'Enter your Instagram username or profile link.';
    const tiktok = 'Enter your TikTok username or profile link.';

    expect(save({ instagramHandle: 'https://evil.example/luna' }).fieldErrors.instagramHandle).toBe(instagram);
    expect(save({ instagramHandle: 'https://instagram.com.evil.example/luna' }).fieldErrors.instagramHandle).toBe(instagram);
    expect(save({ instagramHandle: 'https://m.instagram.com/luna' }).fieldErrors.instagramHandle).toBe(instagram);
    expect(save({ instagramHandle: 'https://instagram.com/' }).fieldErrors.instagramHandle).toBe(instagram);
    expect(save({ twitterHandle: 'https://instagram.com/luna' }).fieldErrors.twitterHandle).toBe(x);
    expect(save({ twitterHandle: 'javascript:alert(1)' }).fieldErrors.twitterHandle).toBe(x);
    expect(save({ twitterHandle: 'ftp://x.com/luna' }).fieldErrors.twitterHandle).toBe(x);
    expect(save({ twitterHandle: 'luna.dreams' }).fieldErrors.twitterHandle).toBe(x);
    expect(save({ twitterHandle: 'a'.repeat(16) }).fieldErrors.twitterHandle).toBe(x);
    expect(save({ instagramHandle: 'a'.repeat(31) }).fieldErrors.instagramHandle).toBe(instagram);
    expect(save({ tiktokHandle: 'l' }).fieldErrors.tiktokHandle).toBe(tiktok);
    expect(save({ tiktokHandle: 'luna dreams' }).fieldErrors.tiktokHandle).toBe(tiktok);
  });

  it('caps the website at 2,048 characters and the location at 80, both trimmed', () => {
    const prefix = 'https://creator.example/';
    const website = `${prefix}${'a'.repeat(2048 - prefix.length)}`;
    expect(website).toHaveLength(2048);

    expect(save({ websiteUrl: ` ${website} ` })).toMatchObject({ fieldErrors: {}, data: { websiteUrl: website } });
    expect(save({ websiteUrl: `${website}a` }).fieldErrors.websiteUrl)
      .toBe('Website URL must be 2,048 characters or fewer.');
    expect(save({ location: ` ${'L'.repeat(80)} ` })).toMatchObject({ fieldErrors: {}, data: { location: 'L'.repeat(80) } });
    expect(save({ location: 'L'.repeat(81) }).fieldErrors.location).toBe('Location must be 80 characters or fewer.');
  });
});

describe('reserved handles', () => {
  it('reserves every handle the shared contract lists', () => {
    expect(reservedHandlesContract.reserved.length).toBeGreaterThan(0);
    for (const handle of reservedHandlesContract.reserved) {
      expect(isReservedProfileUsername(handle), handle).toBe(true);
    }
    expect(isReservedProfileUsername('@Support')).toBe(true);
    expect(isReservedProfileUsername('luna-dreams')).toBe(false);
    expect(isReservedProfileUsername(null)).toBe(false);
  });

  it('refuses a reserved handle to anyone claiming it, never to the account that already holds it', () => {
    expect(getReservedProfileUsernameError('support', 'luna-dreams')).toBe('That handle is reserved.');
    expect(getReservedProfileUsernameError('Support', null)).toBe('That handle is reserved.');
    expect(getReservedProfileUsernameError('support', 'support')).toBeNull();
    expect(getReservedProfileUsernameError('luna-dreams', 'support')).toBeNull();
  });
});
