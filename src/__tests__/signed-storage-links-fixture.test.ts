import { describe, expect, it } from 'vitest';

import { SIGNED_LINK_SECONDS, signedStorageLink, storageOpens } from './fixtures/signed-storage-links';
import { unsignedJwt } from './fixtures/unsigned-jwt';

const NOW = Date.UTC(2026, 10, 2, 9, 0, 0);
const HOUR_MS = SIGNED_LINK_SECONDS * 1000;
const STORAGE = 'https://project.supabase.co/storage/v1/object';

// The creators' tests take `storageOpens` for storage's own answer, so it refuses what storage
// refuses: a stand-in that opened more would let a test pass on a link no browser could open.
describe('storageOpens, the stand-in for storage', () => {
  it('opens a signed link until its hour is up', () => {
    const link = signedStorageLink('generated_images/user-1/a.png', NOW);
    expect(storageOpens(link, NOW + HOUR_MS - 1)).toBe(true);
    expect(storageOpens(link, NOW + HOUR_MS)).toBe(false);
    // A fragment is not part of the request.
    expect(storageOpens(`${link}#t=0.1`, NOW)).toBe(true);
  });

  it('refuses a token signed for another object, and a link with no token it can read', () => {
    const iat = Math.floor(NOW / 1000);
    const forAnother = unsignedJwt({ url: 'generated_images/user-1/b.png', iat, exp: iat + SIGNED_LINK_SECONDS });
    expect(storageOpens(`${STORAGE}/sign/generated_images/user-1/a.png?token=${forAnother}`, NOW)).toBe(false);
    expect(storageOpens(`${STORAGE}/sign/generated_images/user-1/a.png`, NOW)).toBe(false);
    expect(storageOpens(`${STORAGE}/sign/generated_images/user-1/a.png?token=fresh`, NOW)).toBe(false);
  });

  it('opens a public link into a public bucket only', () => {
    expect(storageOpens(`${STORAGE}/public/showcase_media/showcase/gen-1/result.mp4`, NOW)).toBe(true);
    expect(storageOpens(`${STORAGE}/public/generated_videos/user-1/result.mp4`, NOW)).toBe(false);
    expect(storageOpens(`${STORAGE}/public/generation_inputs/user-1/gen-1/00.png`, NOW)).toBe(false);
  });

  it('opens what is not a storage link', () => {
    expect(storageOpens('blob:https://magicbooklet.com/5d1c', NOW)).toBe(true);
  });
});
