import { describe, expect, it } from 'vitest';

import {
  getCreatorProfileReadiness,
  getSafeProfileNextPath,
  isClaimedProfileUsername,
  isGeneratedProfileUsername,
  validateProfileUpdate,
} from '@/lib/profile';

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

  it('requires a claimed handle and display name for public publishing', () => {
    const readiness = getCreatorProfileReadiness({
      username: 'athul-creates',
      displayName: 'Athul Creates',
    });

    expect(readiness.publicPublishReady).toBe(true);
    expect(readiness.sellerReady).toBe(false);
    expect(readiness.missingForSeller).toEqual(['avatar']);
  });

  it('requires avatar for selling and bio for a complete profile while keeping cover optional', () => {
    const sellerReadiness = getCreatorProfileReadiness({
      username: 'athul-creates',
      displayName: 'Athul Creates',
      avatarUrl: 'https://example.com/avatar.png',
    });

    expect(sellerReadiness.sellerReady).toBe(true);
    expect(sellerReadiness.profileComplete).toBe(false);
    expect(sellerReadiness.missingForCompleteProfile).toEqual(['bio']);

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
