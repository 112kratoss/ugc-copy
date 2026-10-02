import { describe, expect, it } from 'vitest';
import { buildMediaSource, cachedVideoSource } from '../lib/media-source';

const base = 'https://magicbooklet.com';
const token = 'test-session';

describe('native media source authentication', () => {
  it.each(['/api/media?bucket=post_media&path=private-posts%2Fpost%2Fimage.webp', '/api/media?bucket=generated_images&path=owner%2Fimage.webp', 'https://magicbooklet.com/api/media?path=image.webp'])('authenticates the owned proxy %s', (url) => {
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

describe('cached video source', () => {
  it.each([
    'https://project.supabase.co/storage/v1/object/sign/generation_inputs/owner/run/03-reference_video.mp4?token=signed',
    'https://cdn.example.com/video.mp4',
    'http://10.0.2.2:3000/video.mp4',
    'HTTPS://cdn.example.com/video.mp4',
  ])('reads the network clip %s through the cache', (uri) => {
    expect(cachedVideoSource({ uri })).toEqual({ uri, useCaching: true });
  });
  it('keeps the credentials of the private-media proxy', () => {
    const source = buildMediaSource('/api/media?bucket=generated_videos&path=owner%2Fvideo.mp4', base, token);
    expect(cachedVideoSource(source)).toEqual({
      uri: base + '/api/media?bucket=generated_videos&path=owner%2Fvideo.mp4',
      headers: { Authorization: 'Bearer test-session' },
      useCaching: true,
    });
  });
  it.each([
    'file:///data/user/0/com.magicbooklet.mobile/cache/picked.mp4',
    'content://media/external/video/media/42',
    'ph://CC95F08C-88C3-4012-9D6D-64A413D254B3/L0/001',
    'asset:/clips/intro.mp4',
    'intro_clip',
    '',
  ])('leaves %s, which is already on the device, out of the cache', (uri) => {
    expect(cachedVideoSource({ uri })).toEqual({ uri, useCaching: false });
  });
});
