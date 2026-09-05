import { describe, expect, it } from 'vitest';
import { getPrivateMediaExpiry, resolveMediaUrlForExpiry } from '../lib/media-url-expiry';

const storage = 'https://project.supabase.co';
const api = 'https://magicbooklet.com';
const signed = (exp: unknown, path = 'generated_images/owner/preview.webp') => `${storage}/storage/v1/object/sign/${path}?token=head.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.signature`;

describe('private signed media expiry', () => {
  it('keeps fresh URLs direct and renews near expiry through the authenticated API', () => {
    const url = signed(1000);
    expect(resolveMediaUrlForExpiry(url, storage, api, 960_000)).toBe(url);
    const renewed = new URL(resolveMediaUrlForExpiry(url, storage, api, 970_000));
    expect(renewed.origin).toBe(api);
    expect(renewed.pathname).toBe('/api/media');
    expect(renewed.searchParams.get('bucket')).toBe('generated_images');
    expect(renewed.searchParams.get('path')).toBe('owner/preview.webp');
    expect(renewed.searchParams.has('token')).toBe(false);
  });
  it.each([null, '1000', -1, 0])('ignores invalid expiry %s', (expiry) => {
    expect(getPrivateMediaExpiry(signed(expiry), storage)).toBeNull();
  });
  it.each([
    signed(1000).replace(storage, 'https://evil.test'),
    signed(1000).replace(storage, 'https://project.supabase.co.evil.test'),
    signed(1000).replace('/sign/', '/public/'),
    signed(1000, 'paid_resources/owner/file.webp'),
    signed(1000, 'generated_images/owner/a%2F..%2Fsecret.webp'),
    `${storage}/storage/v1/object/sign/generated_images/a?token=invalid`,
  ])('does not redirect unsupported or invalid URLs', (url) => {
    expect(resolveMediaUrlForExpiry(url, storage, api, 2_000_000)).toBe(url);
  });
});
