import { describe, expect, it } from 'vitest';
import { shouldAdoptSignedUrl, signedMediaIdentity } from '../lib/use-stable-signed-url';

const storage = 'https://project.supabase.co';
const signed = (exp: number, path = 'generated_videos/owner/generation/playback.mp4', signature = 'sig') =>
  `${storage}/storage/v1/object/sign/${path}?token=head.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.${signature}`;

describe('stable signed playback URLs', () => {
  it('keeps the loading player when a refetch only re-signs the same object', () => {
    const held = signed(4_000, undefined, 'first');
    const next = signed(4_050, undefined, 'second');
    expect(signedMediaIdentity(held)).toBe(signedMediaIdentity(next));
    expect(shouldAdoptSignedUrl(held, next, 1_000_000, storage)).toBe(false);
  });
  it('adopts a fresh signature once the held one is about to expire', () => {
    const held = signed(4_000, undefined, 'first');
    const next = signed(8_000, undefined, 'second');
    expect(shouldAdoptSignedUrl(held, next, 4_000_000 - 59_000, storage)).toBe(true);
    expect(shouldAdoptSignedUrl(held, next, 4_000_000 - 61_000, storage)).toBe(false);
  });
  it('always follows a different object, such as a rendition replacing the original', () => {
    const original = signed(4_000, 'generated_videos/owner/generation/original.mp4');
    const rendition = signed(4_000, 'generated_videos/owner/generation/playback.mp4');
    expect(shouldAdoptSignedUrl(original, rendition, 1_000_000, storage)).toBe(true);
  });
  it('follows the parent for URLs without a readable private signature, and ignores identical URLs', () => {
    expect(shouldAdoptSignedUrl('https://cdn.example/a.mp4?v=1', 'https://cdn.example/a.mp4?v=2', 0, storage)).toBe(true);
    const same = signed(4_000);
    expect(shouldAdoptSignedUrl(same, same, 0, storage)).toBe(false);
  });
});
