import { describe, expect, it } from 'vitest';
import { coverNsfwContent, parseNsfwFlag } from '@/lib/nsfw-content';

describe('manual NSFW content', () => {
  it('withholds originals, nested previews, sensitive text and resource previews', () => {
    const secret = 'https://private.invalid/original';
    const covered = coverNsfwContent({ id: 'post', title: secret, body: secret, prompt: secret,
      description: secret, mediaUrl: secret, mediaItems: [{ url: secret, preview: { url: secret } }],
      asset: { lockedPreview: secret }, resourceBundle: { promptText: secret }, generationId: secret,
      canRemix: true, category: 'video', postFormat: 'media', mediaKind: 'video' });
    expect(JSON.stringify(covered)).not.toContain(secret);
    expect(covered).toMatchObject({ id: 'post', isNsfw: true, nsfwRevealed: false, mediaItems: [], mediaUrl: null, canRemix: false });
  });
  it('distinguishes an omitted old-client label from an explicit unmark', () => {
    expect(parseNsfwFlag(undefined)).toBeUndefined();
    expect(parseNsfwFlag(false)).toBe(false);
    expect(parseNsfwFlag('true')).toBe(true);
    expect(() => parseNsfwFlag('yes')).toThrow();
  });
});
