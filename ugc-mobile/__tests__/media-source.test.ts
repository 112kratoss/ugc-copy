import { describe, expect, it } from 'vitest';
import { buildMediaSource } from '../lib/media-source';

const base = 'https://magicbooklet.com';
const token = 'test-session';

describe('native media source authentication', () => {
  it.each(['/api/media?bucket=generated_images&path=owner%2Fimage.webp', 'https://magicbooklet.com/api/media?path=image.webp'])('authenticates the owned proxy %s', (url) => {
    expect(buildMediaSource(url, base, token)).toEqual({
      uri: new URL(url, base).href, headers: { Authorization: 'Bearer test-session' },
    });
  });
  it.each([
    'https://project.supabase.co/storage/v1/object/sign/generated_images/image.webp?token=signed',
    'https://cdn.example.com/image.webp',
    'https://magicbooklet.com.evil.test/api/media',
    'https://evil.test/api/media',
    '//evil.test/api/media',
    'https://user:password@magicbooklet.com/api/media',
    'https://magicbooklet.com:444/api/media',
    'http://magicbooklet.com/api/media',
    'https://magicbooklet.com/api/other',
    'file:///data/image.webp',
    'data:image/png;base64,AAAA',
    '/api\\media',
  ])('never sends the session to %s', (url) => {
    expect(buildMediaSource(url, base, token)).toEqual({ uri: url });
  });
  it('normalizes a proxy without inventing credentials for a signed-out user', () => {
    expect(buildMediaSource('/api/media?path=a', base)).toEqual({ uri: base + '/api/media?path=a' });
  });
});
